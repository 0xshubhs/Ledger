import { NextRequest, NextResponse } from "next/server"
import { loadDataset, selectInstances, summarize, type InstanceResult } from "@/lib/longmemeval"
import { runInstance } from "@/lib/evalrunner"

interface EvalRequestBody {
  /** Path to a LongMemEval JSON file. Defaults to LONGMEMEVAL_PATH. */
  datasetPath?: string
  limit?: number
  offset?: number
  questionTypes?: string[]
  questionIds?: string[]
  onlyAbstention?: boolean
  includeAbstention?: boolean
  useJudge?: boolean
  concurrency?: number
}

/**
 * Runs a LongMemEval split end-to-end and scores it.
 *
 * A full 500-question run ingests ~24,000 sessions and is a long job — use
 * `scripts/run-eval.mjs` for that, which streams results to disk and can
 * resume. This route is for small splits and for driving the demo UI.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as Partial<EvalRequestBody>
  const datasetPath = body.datasetPath ?? process.env.LONGMEMEVAL_PATH

  if (!datasetPath) {
    return NextResponse.json(
      { error: "datasetPath is required, or set LONGMEMEVAL_PATH in the environment" },
      { status: 400 }
    )
  }

  let instances
  try {
    instances = selectInstances(await loadDataset(datasetPath), {
      limit: body.questionIds?.length ? undefined : body.limit ?? 10,
      offset: body.offset,
      questionTypes: body.questionTypes,
      questionIds: body.questionIds,
      onlyAbstention: body.onlyAbstention,
      includeAbstention: body.includeAbstention,
    })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }

  if (instances.length === 0) {
    return NextResponse.json({ error: "No instances matched that filter" }, { status: 400 })
  }

  const startedAt = Date.now()
  const results: InstanceResult[] = []
  for (const instance of instances) {
    results.push(
      await runInstance(instance, {
        useJudge: body.useJudge ?? true,
        concurrency: body.concurrency ?? 4,
      })
    )
  }

  return NextResponse.json({
    summary: summarize(results),
    wallClockMs: Date.now() - startedAt,
    results,
  })
}
