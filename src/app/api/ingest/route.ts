import { NextRequest, NextResponse } from "next/server"
import {
  ingestSession,
  getKnownPredicates,
  type IngestMessage,
  type ExtractedFact,
} from "@/lib/memory"
import { extractFacts } from "@/lib/extract"

interface IngestRequestBody {
  userExternalId: string
  sessionIndex: number
  startedAt?: number
  messages: IngestMessage[]
  /** Skip the extraction call and write these facts directly (used by the eval harness). */
  facts?: ExtractedFact[]
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<IngestRequestBody>

  if (!body.userExternalId || body.sessionIndex === undefined || !Array.isArray(body.messages)) {
    return NextResponse.json(
      { error: "userExternalId, sessionIndex, and messages are required" },
      { status: 400 }
    )
  }

  // Messages carry their own timestamps. Falling back to Date.now() for the
  // whole session would flatten every turn onto one instant and make temporal
  // questions ("what did they decide after the migration") unanswerable, so a
  // missing ts is derived from position instead.
  const startedAt = body.startedAt ?? body.messages[0]?.ts ?? Date.now()
  const messages: IngestMessage[] = body.messages.map((m, i) => ({
    role: m.role,
    content: m.content,
    ts: typeof m.ts === "number" ? m.ts : startedAt + i,
  }))

  const startedMs = Date.now()
  // Supplied facts skip extraction entirely (that is how the console demos the
  // graph without an LLM). Otherwise extraction is primed with the relation
  // names this user's memory already uses, so an update reuses one instead of
  // coining a synonym the supersede logic cannot match.
  const facts =
    body.facts ??
    (await extractFacts(messages, await getKnownPredicates(body.userExternalId)))
  const extractMs = Date.now() - startedMs

  const result = await ingestSession({
    userExternalId: body.userExternalId,
    sessionIndex: body.sessionIndex,
    startedAt,
    messages,
    facts,
  })

  return NextResponse.json({
    ok: true,
    factsExtracted: facts.length,
    extractMs,
    writeMs: Date.now() - startedMs - extractMs,
    ...result,
    facts,
  })
}
