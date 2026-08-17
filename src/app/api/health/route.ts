import { NextResponse } from "next/server"
import { checkHealth } from "@/lib/hydradb"
import { checkLlm, describeProvider } from "@/lib/llm"

/**
 * Reports both dependencies, because a run can fail on either one and the
 * symptom looks identical from the outside. `?llm=1` also pings the model, which
 * costs a round trip so it is opt-in.
 */
export async function GET(req: Request) {
  const healthy = await checkHealth()
  const wantLlm = new URL(req.url).searchParams.get("llm") === "1"

  const llm = wantLlm
    ? { ...describeProvider(), ...(await checkLlm()) }
    : describeProvider()

  const ok = healthy && (!wantLlm || (llm as { ok?: boolean }).ok !== false)
  return NextResponse.json({ healthy, llm }, { status: ok ? 200 : 503 })
}
