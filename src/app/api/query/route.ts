import { NextRequest, NextResponse } from "next/server"
import {
  retrieveFacts,
  getProvenanceForFacts,
  multiHopFromEntity,
  entityVertexId,
} from "@/lib/memory"
import { planQuery, synthesizeAnswer } from "@/lib/extract"

interface QueryRequestBody {
  userExternalId: string
  /** Natural-language question — planned into a graph lookup. */
  question?: string
  /** Or address the graph directly, bypassing the planner. */
  subject?: string
  predicate?: string
  history?: boolean
  /** Skip answer synthesis and return the retrieved subgraph only. */
  retrieveOnly?: boolean
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<QueryRequestBody>

  if (!body.userExternalId) {
    return NextResponse.json({ error: "userExternalId is required" }, { status: 400 })
  }
  if (!body.question && !(body.subject && body.predicate)) {
    return NextResponse.json(
      { error: "either question, or both subject and predicate, are required" },
      { status: 400 }
    )
  }

  const startedAt = Date.now()

  const plan = body.question
    ? await planQuery(body.question)
    : {
        subject: body.subject!,
        predicate: body.predicate!,
        wantsHistory: body.history === true,
        entities: [],
      }

  // Retrieval is a graph lookup, not a similarity search: narrowest tier first,
  // widening to the user's working set rather than guessing again. See
  // retrieveFacts in memory.ts for why the last tier exists.
  // A natural-language question was planned into a predicate guess, so retrieval
  // widens when the guess misses. A caller that named subject and predicate
  // itself gets the narrow answer, including the empty one.
  const { facts, path: retrievalPath } = await retrieveFacts(body.userExternalId, plan, {
    widen: Boolean(body.question),
  })

  const retrieveMs = Date.now() - startedAt

  // Zero rows is a real answer here. Nothing downstream is allowed to turn an
  // empty retrieval into a plausible-sounding guess.
  if (facts.length === 0) {
    return NextResponse.json({
      answer: null,
      abstained: true,
      reason: "Not found in memory",
      plan,
      retrievalPath,
      facts: [],
      retrieveMs,
    })
  }

  // Source turns for the top retrieved facts, keyed by fact id. The console
  // quotes them, and synthesis reads them for detail the triple dropped.
  const provenanceByFact = await getProvenanceForFacts(facts)
  const provenance = provenanceByFact.get(facts[0].id) ?? []

  if (body.retrieveOnly) {
    return NextResponse.json({ plan, retrievalPath, facts, provenance, retrieveMs })
  }

  const { answer, abstained } = await synthesizeAnswer(
    body.question ?? `${plan.subject} ${plan.predicate}?`,
    facts,
    provenanceByFact
  )

  return NextResponse.json({
    answer,
    abstained,
    ...(abstained ? { reason: "Retrieved facts do not answer the question" } : {}),
    plan,
    retrievalPath,
    facts,
    provenance,
    retrieveMs,
    totalMs: Date.now() - startedAt,
  })
}

/** Multi-hop exploration around one entity, for the explainability panel. */
export async function GET(req: NextRequest) {
  const entity = req.nextUrl.searchParams.get("entity")
  if (!entity) {
    return NextResponse.json({ error: "?entity= is required for multi-hop lookup" }, { status: 400 })
  }
  const maxLen = Number(req.nextUrl.searchParams.get("maxLen") ?? 4)
  const paths = await multiHopFromEntity(entity, maxLen)
  // The entity's own vertex id goes back with the paths: the drawing needs to
  // know which node the traversal started from to lay the columns out by hop
  // distance, and a path's node order alone does not say that.
  return NextResponse.json({ entity, entityId: entityVertexId(entity), pathCount: paths.length, paths })
}
