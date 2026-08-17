import { NextRequest, NextResponse } from "next/server"
import {
  getCurrentFact,
  getFactHistory,
  getFactsAboutEntity,
  getFactProvenance,
  multiHopFromEntity,
  type FactRow,
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

  // Retrieval is a bounded graph lookup, not a similarity search. If the
  // (subject, predicate) lookup misses, fall back to the entities named in the
  // question — that is the multi-hop path, not a reranked guess.
  let facts: FactRow[] = []
  let retrievalPath: "current" | "history" | "entity" | "none" = "none"

  if (plan.wantsHistory) {
    facts = await getFactHistory(body.userExternalId, plan.subject, plan.predicate)
    if (facts.length > 0) retrievalPath = "history"
  } else if (plan.predicate) {
    const current = await getCurrentFact(body.userExternalId, plan.subject, plan.predicate)
    if (current) {
      facts = [current]
      retrievalPath = "current"
    }
  }

  if (facts.length === 0 && plan.entities.length > 0) {
    const perEntity = await Promise.all(
      plan.entities.map((name) => getFactsAboutEntity(body.userExternalId!, name))
    )
    const seen = new Set<number>()
    facts = perEntity.flat().filter((f) => !seen.has(f.id) && seen.add(f.id))
    if (facts.length > 0) retrievalPath = "entity"
  }

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

  const provenance = await getFactProvenance(facts[0].id)

  if (body.retrieveOnly) {
    return NextResponse.json({ plan, retrievalPath, facts, provenance, retrieveMs })
  }

  const { answer, abstained } = await synthesizeAnswer(
    body.question ?? `${plan.subject} ${plan.predicate}?`,
    facts
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
  return NextResponse.json({ entity, pathCount: paths.length, paths })
}
