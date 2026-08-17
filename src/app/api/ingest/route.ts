import { NextRequest, NextResponse } from "next/server"
import { ingestSession, type IngestMessage } from "@/lib/memory"
import { extractFacts } from "@/lib/extract"

interface IngestRequestBody {
  userExternalId: string
  sessionIndex: number
  startedAt?: number
  messages: IngestMessage[]
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<IngestRequestBody>

  if (!body.userExternalId || body.sessionIndex === undefined || !Array.isArray(body.messages)) {
    return NextResponse.json(
      { error: "userExternalId, sessionIndex, and messages are required" },
      { status: 400 }
    )
  }

  const transcript = body.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
  const facts = await extractFacts(transcript)

  await ingestSession({
    userExternalId: body.userExternalId,
    sessionIndex: body.sessionIndex,
    startedAt: body.startedAt ?? Date.now(),
    messages: body.messages,
    facts,
  })

  return NextResponse.json({ ok: true, factsExtracted: facts.length, facts })
}
