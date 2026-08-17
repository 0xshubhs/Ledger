import { runQuery } from "./hydradb"
import { stableId } from "./id"

export interface ExtractedFact {
  subject: string
  predicate: string
  object: string
  entities: string[]
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
  object: string
  validFrom: number
  validTo?: number
}

/** Sentinel for Fact.valid_to meaning "still current" — HydraDB's WHERE clause
 *  doesn't support IS NULL, so "currently valid" is 0 rather than absent. */
const STILL_VALID = 0

/**
 * Writes one full session (messages + pre-extracted facts) into the graph.
 * Every batch write follows the two-pass UNWIND shape documented in
 * cypher-compat.md (upsert vertices, then match-and-connect) rather than
 * threading a WITH clause, since WITH in this dialect is pass-through only.
 */
export async function ingestSession(input: IngestSessionInput): Promise<void> {
  const userId = stableId(`user:${input.userExternalId}`)
  const sessionId = stableId(`session:${input.userExternalId}:${input.sessionIndex}`)

  await runQuery(
    `MERGE (u {id: $userId}) SET u:User, u.external_id = $externalId`,
    { params: { userId, externalId: input.userExternalId }, consistency: "strong" }
  )
  await runQuery(
    `MERGE (s {id: $sessionId}) SET s:Session, s.session_index = $sessionIndex, s.started_at = $startedAt`,
    {
      params: { sessionId, sessionIndex: input.sessionIndex, startedAt: input.startedAt },
      consistency: "strong",
    }
  )
  await runQuery(
    `MATCH (u:User {id: $userId}), (s:Session {id: $sessionId}) MERGE (u)-[:HAS_SESSION]->(s)`,
    { params: { userId, sessionId }, consistency: "strong" }
  )

  if (input.messages.length > 0) {
    const rows = input.messages.map((m, i) => ({
      vertex: stableId(`message:${input.userExternalId}:${input.sessionIndex}:${i}`),
      session_id: sessionId,
      role: m.role,
      ts: m.ts,
    }))

    await runQuery(
      `UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Message, n.role = row.role, n.ts = row.ts`,
      { params: { rows }, consistency: "strong" }
    )
    await runQuery(
      `UNWIND $rows AS row
       MATCH (s:Session {id: row.session_id}), (m {id: row.vertex})
       MERGE (s)-[:CONTAINS]->(m)`,
      { params: { rows }, consistency: "strong" }
    )
  }

  // The most recent message stands in as the "source" for facts asserted in
  // this session — good enough provenance for a hackathon-scope memory layer.
  const sourceMessageId =
    input.messages.length > 0
      ? stableId(`message:${input.userExternalId}:${input.sessionIndex}:${input.messages.length - 1}`)
      : null

  for (const fact of input.facts) {
    await writeFact(input.userExternalId, fact, input.startedAt, sourceMessageId)
  }
}

/**
 * Writes one extracted fact with knowledge-update semantics: if a current
 * fact exists for the same (subject, predicate) and its object differs, the
 * old fact is closed off (valid_to = new fact's valid_from) and linked via
 * SUPERSEDES rather than overwritten — so history is queryable, not lost.
 */
async function writeFact(
  userExternalId: string,
  fact: ExtractedFact,
  validFrom: number,
  sourceMessageId: number | null
): Promise<void> {
  const current = await getCurrentFact(userExternalId, fact.subject, fact.predicate)

  if (current && current.object === fact.object) {
    return // unchanged — nothing to write
  }

  const newFactId = stableId(
    `fact:${userExternalId}:${fact.subject}:${fact.predicate}:${validFrom}`
  )

  await runQuery(
    `MERGE (f {id: $factId})
     SET f:Fact, f.user_id = $userId, f.subject = $subject, f.predicate = $predicate,
         f.object = $object, f.valid_from = $validFrom, f.valid_to = $stillValid`,
    {
      params: {
        factId: newFactId,
        userId: stableId(`user:${userExternalId}`),
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        validFrom,
        stillValid: STILL_VALID,
      },
      consistency: "strong",
    }
  )

  if (current) {
    await runQuery(
      `MATCH (old {id: $oldId}) SET old.valid_to = $validFrom`,
      { params: { oldId: current.id, validFrom }, consistency: "strong" }
    )
    await runQuery(
      `MATCH (newF {id: $newId}), (old {id: $oldId}) MERGE (newF)-[:SUPERSEDES]->(old)`,
      { params: { newId: newFactId, oldId: current.id }, consistency: "strong" }
    )
  }

  if (sourceMessageId !== null) {
    await runQuery(
      `MATCH (m {id: $messageId}), (f {id: $factId}) MERGE (m)-[:ASSERTS]->(f)`,
      { params: { messageId: sourceMessageId, factId: newFactId }, consistency: "strong" }
    )
  }

  for (const entityName of fact.entities) {
    const entityId = stableId(`entity:${entityName.toLowerCase()}`)
    await runQuery(
      `MERGE (e {id: $entityId}) SET e:Entity, e.name = $name`,
      { params: { entityId, name: entityName }, consistency: "strong" }
    )
    await runQuery(
      `MATCH (f {id: $factId}), (e {id: $entityId}) MERGE (f)-[:ABOUT]->(e)`,
      { params: { factId: newFactId, entityId }, consistency: "strong" }
    )
  }
}

/** Returns the currently-valid fact for (subject, predicate), or null if none. */
export async function getCurrentFact(
  userExternalId: string,
  subject: string,
  predicate: string
): Promise<FactRow | null> {
  const userId = stableId(`user:${userExternalId}`)
  const { rows } = await runQuery<{ id: number; object: string; validFrom: number }>(
    `MATCH (f:Fact) WHERE f.user_id = $userId AND f.subject = $subject AND f.predicate = $predicate AND f.valid_to = $stillValid
     RETURN f.id AS id, f.object AS object, f.valid_from AS validFrom
     ORDER BY f.valid_from DESC LIMIT 1`,
    { params: { userId, subject, predicate, stillValid: STILL_VALID } }
  )
  return rows[0] ?? null
}

/** Returns the full version history for (subject, predicate), oldest first. */
export async function getFactHistory(
  userExternalId: string,
  subject: string,
  predicate: string
): Promise<FactRow[]> {
  const userId = stableId(`user:${userExternalId}`)
  const { rows } = await runQuery<FactRow>(
    `MATCH (f:Fact) WHERE f.user_id = $userId AND f.subject = $subject AND f.predicate = $predicate
     RETURN f.id AS id, f.object AS object, f.valid_from AS validFrom, f.valid_to AS validTo
     ORDER BY f.valid_from`,
    { params: { userId, subject, predicate } }
  )
  return rows
}

/**
 * Multi-hop reasoning across sessions: bounded paths from one entity through
 * ABOUT edges, via HydraDB's native path procedure (no client-side fan-out).
 */
export async function multiHopFromEntity(entityName: string, maxLen = 3, pathCount = 20) {
  const entityId = stableId(`entity:${entityName.toLowerCase()}`)
  const { rows } = await runQuery(
    `CALL algo.SSpaths({sourceNode: $entityId, relTypes: ['ABOUT'], relDirection: 'both', maxLen: $maxLen, pathCount: $pathCount})
     YIELD path RETURN path`,
    { params: { entityId, maxLen, pathCount } }
  )
  return rows
}
