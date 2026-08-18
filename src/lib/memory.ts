import { runQuery, HydraSession, type GraphPath, type Consistency } from "./hydradb"
import { stableId } from "./id"
import { writeVertices, writeEdges, chunk, type VertexRow, type EdgeRow } from "./graphwrite"

export interface ExtractedFact {
  subject: string
  predicate: string
  object: string
  entities: string[]
  /** Index of the message that asserted this fact, when the extractor knows it. */
  sourceMessageIndex?: number
}

export interface IngestMessage {
  role: "user" | "assistant"
  content: string
  ts: number
}

export interface IngestSessionInput {
  userExternalId: string
  sessionIndex: number
  startedAt: number
  messages: IngestMessage[]
  facts: ExtractedFact[]
}

export interface FactRow {
  id: number
  subject: string
  predicate: string
  object: string
  validFrom: number
  validTo: number
  sessionIndex: number
}

/**
 * Sentinel for Fact.valid_to meaning "still current". HydraDB's WHERE rejects
 * `IS NULL` outright, so an open-ended interval is 0 rather than absent — every
 * current-truth query filters `valid_to = 0`.
 */
export const STILL_VALID = 0

function userId(userExternalId: string): number {
  return stableId(`user:${userExternalId}`)
}

function sessionVertexId(userExternalId: string, sessionIndex: number): number {
  return stableId(`session:${userExternalId}:${sessionIndex}`)
}

function messageVertexId(userExternalId: string, sessionIndex: number, index: number): number {
  return stableId(`message:${userExternalId}:${sessionIndex}:${index}`)
}

/** Vertex id for a named entity. Exported so a route can address one directly. */
export function entityVertexId(name: string): number {
  return stableId(`entity:${name.trim().toLowerCase()}`)
}

/**
 * A fact's identity includes its object, not just (subject, predicate, time).
 * Keying on time alone collides when one session revises the same predicate
 * twice: the second write would MERGE onto the first node, overwrite it in
 * place, then close it against its own valid_from and link SUPERSEDES to
 * itself — losing the update and corrupting the history it exists to preserve.
 */
function factVertexId(
  userExternalId: string,
  subject: string,
  predicate: string,
  object: string,
  validFrom: number
): number {
  return stableId(`fact:${userExternalId}:${subject}:${predicate}:${object}:${validFrom}`)
}

export interface IngestSessionResult {
  messagesWritten: number
  factsWritten: number
  factsSuperseded: number
  factsUnchanged: number
  bookmark?: string
}

/**
 * Writes one full session (messages + pre-extracted facts) into the graph.
 *
 * Every write goes through the UNWIND batch form. That is not an optimisation
 * choice — HydraDB rejects a standalone `MERGE (n {id: $x})` and rejects
 * `MERGE ... SET ...` in a single statement, so UNWIND is the only way to put a
 * vertex in the graph. See graphwrite.ts for the exact constraints.
 */
export async function ingestSession(input: IngestSessionInput): Promise<IngestSessionResult> {
  const session = new HydraSession()
  const uid = userId(input.userExternalId)
  const sid = sessionVertexId(input.userExternalId, input.sessionIndex)

  const lastTs = input.messages.length
    ? input.messages[input.messages.length - 1].ts
    : input.startedAt

  await writeVertices(session, "User", [
    { vertex: uid, external_id: input.userExternalId },
  ])
  await writeVertices(session, "Session", [
    {
      vertex: sid,
      user_id: uid,
      session_index: input.sessionIndex,
      started_at: input.startedAt,
      ended_at: lastTs,
    },
  ])
  await writeEdges(session, "User", "HAS_SESSION", "Session", [{ from: uid, to: sid }])

  // Message content is stored on the vertex, not just referenced. The demo's
  // "why this answer" panel has to quote the turn a fact came from, and a
  // provenance edge pointing at a vertex with no text can't do that.
  const messageRows: VertexRow[] = input.messages.map((m, i) => ({
    vertex: messageVertexId(input.userExternalId, input.sessionIndex, i),
    session_id: sid,
    session_index: input.sessionIndex,
    message_index: i,
    role: m.role,
    content: m.content,
    ts: m.ts,
  }))

  for (const batch of chunk(messageRows)) {
    await writeVertices(session, "Message", batch)
  }
  for (const batch of chunk(messageRows.map((row) => ({ from: sid, to: row.vertex })))) {
    await writeEdges(session, "Session", "CONTAINS", "Message", batch)
  }

  let factsWritten = 0
  let factsSuperseded = 0
  let factsUnchanged = 0

  for (const fact of input.facts) {
    const outcome = await writeFact(session, input, fact)
    if (outcome === "written") factsWritten++
    else if (outcome === "superseded") factsSuperseded++
    else factsUnchanged++
  }

  return {
    messagesWritten: messageRows.length,
    factsWritten,
    factsSuperseded,
    factsUnchanged,
    bookmark: session.lastBookmark,
  }
}

type FactOutcome = "written" | "superseded" | "unchanged"

/**
 * Writes one extracted fact with knowledge-update semantics.
 *
 * If a current fact exists for the same (subject, predicate) and its object
 * differs, the old fact is closed off (valid_to = the new fact's valid_from) and
 * linked by SUPERSEDES rather than overwritten. Nothing is ever deleted, so
 * "what do you believe now" and "what did you believe in March" are the same
 * query with a different time filter — the property a vector store's
 * overwrite-or-duplicate behaviour cannot give you.
 */
async function writeFact(
  session: HydraSession,
  input: IngestSessionInput,
  fact: ExtractedFact
): Promise<FactOutcome> {
  const uid = userId(input.userExternalId)

  // Facts are timestamped by the message that asserted them where the extractor
  // identified one, falling back to the session start. Temporal-reasoning
  // questions ("what did they say after X") depend on this being per-turn.
  const sourceIndex =
    fact.sourceMessageIndex !== undefined && input.messages[fact.sourceMessageIndex]
      ? fact.sourceMessageIndex
      : input.messages.length - 1
  const validFrom =
    sourceIndex >= 0 && input.messages[sourceIndex]
      ? input.messages[sourceIndex].ts
      : input.startedAt

  const current = await getCurrentFact(input.userExternalId, fact.subject, fact.predicate)
  if (current && current.object === fact.object) {
    return "unchanged"
  }

  const factId = factVertexId(
    input.userExternalId,
    fact.subject,
    fact.predicate,
    fact.object,
    validFrom
  )

  await writeVertices(session, "Fact", [
    {
      vertex: factId,
      user_id: uid,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      valid_from: validFrom,
      valid_to: STILL_VALID,
      session_index: input.sessionIndex,
    },
  ])

  if (current) {
    await session.run(`MATCH (f:Fact {id: $oldId}) SET f.valid_to = $validFrom`, {
      oldId: current.id,
      validFrom,
    })
    await writeEdges(session, "Fact", "SUPERSEDES", "Fact", [{ from: factId, to: current.id }])
  }

  if (sourceIndex >= 0 && input.messages[sourceIndex]) {
    const messageId = messageVertexId(input.userExternalId, input.sessionIndex, sourceIndex)
    await writeEdges(session, "Message", "ASSERTS", "Fact", [{ from: messageId, to: factId }])
  }

  const entityRows: VertexRow[] = []
  const aboutRows: EdgeRow[] = []
  for (const entityName of fact.entities) {
    if (!entityName?.trim()) continue
    const eid = entityVertexId(entityName)
    entityRows.push({ vertex: eid, name: entityName, normalized: entityName.trim().toLowerCase() })
    aboutRows.push({ from: factId, to: eid })
  }
  if (entityRows.length > 0) {
    await writeVertices(session, "Entity", entityRows)
    await writeEdges(session, "Fact", "ABOUT", "Entity", aboutRows)
  }

  return current ? "superseded" : "written"
}

/** Returns the currently-valid fact for (subject, predicate), or null if none. */
export async function getCurrentFact(
  userExternalId: string,
  subject: string,
  predicate: string,
  options: { consistency?: Consistency; bookmark?: string } = {}
): Promise<FactRow | null> {
  const { rows } = await runQuery<FactRow>(
    `MATCH (f:Fact)
     WHERE f.user_id = $userId AND f.subject = $subject AND f.predicate = $predicate
       AND f.valid_to = $stillValid
     RETURN f.id AS id, f.subject AS subject, f.predicate AS predicate, f.object AS object,
            f.valid_from AS validFrom, f.valid_to AS validTo, f.session_index AS sessionIndex
     ORDER BY validFrom DESC LIMIT 1`,
    {
      params: {
        userId: userId(userExternalId),
        subject,
        predicate,
        stillValid: STILL_VALID,
      },
      ...options,
    }
  )
  return rows[0] ?? null
}

/** Returns the full version history for (subject, predicate), oldest first. */
export async function getFactHistory(
  userExternalId: string,
  subject: string,
  predicate: string
): Promise<FactRow[]> {
  const { rows } = await runQuery<FactRow>(
    `MATCH (f:Fact)
     WHERE f.user_id = $userId AND f.subject = $subject AND f.predicate = $predicate
     RETURN f.id AS id, f.subject AS subject, f.predicate AS predicate, f.object AS object,
            f.valid_from AS validFrom, f.valid_to AS validTo, f.session_index AS sessionIndex
     ORDER BY validFrom`,
    { params: { userId: userId(userExternalId), subject, predicate } }
  )
  return rows
}

/** Every current fact for a user — the working set an answer step reasons over. */
export async function getAllCurrentFacts(
  userExternalId: string,
  limit = 200
): Promise<FactRow[]> {
  const { rows } = await runQuery<FactRow>(
    `MATCH (f:Fact) WHERE f.user_id = $userId AND f.valid_to = $stillValid
     RETURN f.id AS id, f.subject AS subject, f.predicate AS predicate, f.object AS object,
            f.valid_from AS validFrom, f.valid_to AS validTo, f.session_index AS sessionIndex
     ORDER BY validFrom LIMIT $limit`,
    { params: { userId: userId(userExternalId), stillValid: STILL_VALID, limit } }
  )
  return rows
}

export type RetrievalPath = "current" | "history" | "entity" | "working-set" | "none"

export interface RetrievalPlan {
  subject: string
  predicate: string
  wantsHistory: boolean
  entities: string[]
}

export interface RetrievalResult {
  facts: FactRow[]
  path: RetrievalPath
}

/**
 * Resolves a planned question into a fact set: narrowest lookup first, then
 * widened, with the tiers unioned rather than raced.
 *
 * The tiers matter, and tier 3 exists because of a measured failure. Tiers 1 and
 * 2 require two independent model calls — the extractor that chose a predicate
 * string, and the planner that guesses one — to land on the same arbitrary
 * snake_case token. On LongMemEval single-session-user that agreement happened
 * once in sixteen: every other instance had facts in the graph and retrieved
 * `none`, because the extractor had written `commute_duration` while the planner
 * asked for `daily_commute_length`. Accuracy was 6% for that reason alone.
 *
 * So the last tier stops guessing and hands the answer layer the user's current
 * working set, letting synthesis do the matching over text it can actually read.
 * That is a deliberate trade: less "one bounded lookup" purity, far better
 * recall, and it still cannot invent anything, because
 *
 *   - a user with no facts yields zero rows and the caller abstains, and
 *   - synthesis is separately required to emit NOT_IN_MEMORY when the facts it
 *     was handed do not answer the question.
 *
 * Abstention therefore survives the change; only the "we found nothing because
 * we guessed the wrong key" failure goes away.
 *
 * The tiers are unioned rather than returned first-match-first for a second
 * measured reason: a narrow hit that lands is usually still incomplete. On
 * temporal-reasoning questions the entity tier returned two to five facts,
 * short-circuited the working set, and the answer layer abstained for want of
 * the other half of the comparison.
 */
export async function retrieveFacts(
  userExternalId: string,
  plan: RetrievalPlan,
  options: { workingSetLimit?: number } = {}
): Promise<RetrievalResult> {
  const limit = options.workingSetLimit ?? 200
  const facts: FactRow[] = []
  const seen = new Set<number>()
  let path: RetrievalPath = "none"

  const add = (rows: FactRow[], from: RetrievalPath) => {
    let added = 0
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      facts.push(row)
      added++
    }
    if (added > 0 && path === "none") path = from
  }

  if (plan.predicate) {
    if (plan.wantsHistory) {
      add(await getFactHistory(userExternalId, plan.subject, plan.predicate), "history")
    } else {
      const current = await getCurrentFact(userExternalId, plan.subject, plan.predicate)
      if (current) add([current], "current")
    }
  }

  if (plan.entities.length > 0) {
    const perEntity = await Promise.all(
      plan.entities.map((name) => getFactsAboutEntity(userExternalId, name))
    )
    add(perEntity.flat(), "entity")
  }

  // The working set is added on top of the narrow hits rather than only when
  // they miss. A narrow hit that lands is still usually incomplete: "which did I
  // do first, the workshop or the webinar" needs both events, and an entity
  // lookup on one of them returns two facts and nothing to compare them
  // against. Measured on temporal-reasoning, every early-returned entity hit
  // retrieved 2-5 facts and then abstained. Ordering keeps the targeted rows
  // first, so `path` still reports how the question was actually matched.
  add(await getAllCurrentFacts(userExternalId, limit), "working-set")

  return { facts: facts.slice(0, limit), path }
}

/**
 * The turns that asserted each of these facts, keyed by fact id.
 *
 * A triple loses detail the question may be asking for — "GPS system not
 * functioning correctly" survives extraction as `car_issue: GPS` at best — so
 * the answer layer reads the original sentence alongside the fact. There is no
 * `IN` operator, so this is one id-keyed query per fact, bounded by `limit` and
 * issued concurrently.
 */
export async function getProvenanceForFacts(
  facts: FactRow[],
  limit = 24
): Promise<Map<number, ProvenanceRow[]>> {
  const wanted = facts.slice(0, limit)
  const rows = await Promise.all(wanted.map((fact) => getFactProvenance(fact.id)))
  const byFact = new Map<number, ProvenanceRow[]>()
  wanted.forEach((fact, i) => {
    if (rows[i].length > 0) byFact.set(fact.id, rows[i])
  })
  return byFact
}

export async function getFactsAboutEntity(
  userExternalId: string,
  entityName: string
): Promise<FactRow[]> {
  const { rows } = await runQuery<FactRow>(
    `MATCH (f:Fact)-[:ABOUT]->(e:Entity)
     WHERE e.id = $entityId AND f.user_id = $userId AND f.valid_to = $stillValid
     RETURN f.id AS id, f.subject AS subject, f.predicate AS predicate, f.object AS object,
            f.valid_from AS validFrom, f.valid_to AS validTo, f.session_index AS sessionIndex
     ORDER BY validFrom`,
    {
      params: {
        entityId: entityVertexId(entityName),
        userId: userId(userExternalId),
        stillValid: STILL_VALID,
      },
    }
  )
  return rows
}

export interface ProvenanceRow {
  messageId: number
  role: string
  content: string
  ts: number
  sessionIndex: number
}

/**
 * The turn that asserted a fact — this is what makes an answer auditable rather
 * than merely plausible, and it is why Message.content is stored on the vertex.
 */
export async function getFactProvenance(factId: number): Promise<ProvenanceRow[]> {
  const { rows } = await runQuery<ProvenanceRow>(
    `MATCH (m:Message)-[:ASSERTS]->(f:Fact) WHERE f.id = $factId
     RETURN m.id AS messageId, m.role AS role, m.content AS content, m.ts AS ts,
            m.session_index AS sessionIndex
     ORDER BY ts`,
    { params: { factId } }
  )
  return rows
}

/**
 * Multi-hop reasoning across sessions: bounded paths outward from one entity
 * through the fact graph, via HydraDB's native path procedure rather than a
 * client-side fan-out of per-hop queries.
 *
 * `relTypes` is a literal array in the query string on purpose — passing it as
 * a parameter is rejected ("composite parameter $relTypes is only supported as
 * an UNWIND input"). Scalar config values are fine as parameters.
 */
export async function multiHopFromEntity(
  entityName: string,
  maxLen = 4,
  pathCount = 50
): Promise<GraphPath[]> {
  const { rows } = await runQuery<{ path: GraphPath }>(
    `CALL algo.SSpaths({sourceNode: $entityId, relTypes: ['ABOUT','SUPERSEDES','ASSERTS','CONTAINS'],
                        relDirection: 'both', maxLen: $maxLen, pathCount: $pathCount})
     YIELD path RETURN path`,
    { params: { entityId: entityVertexId(entityName), maxLen, pathCount } }
  )
  return rows.map((row) => row.path).filter(Boolean)
}

/**
 * Relation names already used for this user, most recent first.
 *
 * Fed back into extraction so a later statement about the same thing reuses the
 * existing predicate rather than inventing a new one. That is what makes an
 * update an update: supersede is keyed on (subject, predicate), so
 * `ran_charity_5K_in` followed by `has_personal_best_time` leaves two unrelated
 * current facts and the store cannot tell that one replaced the other.
 */
export async function getKnownPredicates(
  userExternalId: string,
  limit = 120
): Promise<string[]> {
  const { rows } = await runQuery<{ predicate: string }>(
    `MATCH (f:Fact) WHERE f.user_id = $userId
     RETURN DISTINCT f.predicate AS predicate LIMIT $limit`,
    { params: { userId: userId(userExternalId), limit } }
  )
  return rows.map((row) => row.predicate).filter(Boolean)
}

export interface MemoryStats {
  sessions: number
  messages: number
  facts: number
  entities: number
}

/** Counts for the demo UI header, one aggregate per label. */
export async function getMemoryStats(): Promise<MemoryStats> {
  const count = async (label: string) => {
    const { rows } = await runQuery<{ total: number }>(
      `MATCH (n:${label}) RETURN count(*) AS total`
    )
    return Number(rows[0]?.total ?? 0)
  }
  const [sessions, messages, facts, entities] = await Promise.all([
    count("Session"),
    count("Message"),
    count("Fact"),
    count("Entity"),
  ])
  return { sessions, messages, facts, entities }
}
