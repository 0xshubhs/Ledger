import { NextResponse } from "next/server"
import { checkHealth } from "@/lib/hydradb"

export async function GET() {
  const healthy = await checkHealth()
  return NextResponse.json({ healthy }, { status: healthy ? 200 : 503 })
}
