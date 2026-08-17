import { NextRequest, NextResponse } from "next/server"
import { getCurrentFact, getFactHistory, multiHopFromEntity } from "@/lib/memory"

interface QueryRequestBody {
  userExternalId: string
  subject: string
  predicate: string
  history?: boolean
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<QueryRequestBody>

  if (!body.userExternalId || !body.subject || !body.predicate) {
    return NextResponse.json(
      { error: "userExternalId, subject, and predicate are required" },
      { status: 400 }
    )
  }

  if (body.history) {
    const rows = await getFactHistory(body.userExternalId, body.subject, body.predicate)
    return NextResponse.json({ history: rows, abstained: rows.length === 0 })
  }

  const fact = await getCurrentFact(body.userExternalId, body.subject, body.predicate)
  if (!fact) {
    return NextResponse.json({ answer: null, abstained: true, reason: "Not found in memory" })
  }

  return NextResponse.json({ answer: fact.object, validFrom: fact.validFrom, abstained: false })
}

export async function GET(req: NextRequest) {
  const entity = req.nextUrl.searchParams.get("entity")
  if (!entity) {
    return NextResponse.json({ error: "?entity= is required for multi-hop lookup" }, { status: 400 })
  }
  const paths = await multiHopFromEntity(entity)
  return NextResponse.json({ paths })
}
