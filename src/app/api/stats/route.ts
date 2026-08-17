import { NextResponse } from "next/server"
import { getMemoryStats } from "@/lib/memory"
import { checkHealth } from "@/lib/hydradb"

export async function GET() {
  const healthy = await checkHealth()
  if (!healthy) {
    return NextResponse.json({ healthy, error: "graph-node is not reachable" }, { status: 503 })
  }
  return NextResponse.json({ healthy, ...(await getMemoryStats()) })
}
