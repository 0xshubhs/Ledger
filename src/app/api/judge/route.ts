import { NextRequest, NextResponse } from "next/server"
import { gradeAnswer } from "@/lib/longmemeval"

interface JudgeRequestBody {
  question: string
  answer: string
  gold: string
}

/**
 * Grades one answer with the judge model, using exactly the grading path the
 * eval runner uses (string match first, judge only when that is inconclusive).
 *
 * This exists so judging can be a second pass over a finished run rather than a
 * step inside each instance. Locally that is not a stylistic preference: the
 * judge is deliberately a *different* model from the one under test, Ollama
 * holds one model in memory at a time by default, and interleaving them means
 * paying a model load twice per instance. Grading a whole run in one pass pays
 * it once. See scripts/judge-run.mjs.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<JudgeRequestBody>

  if (!body.question || !body.gold || typeof body.answer !== "string") {
    return NextResponse.json(
      { error: "question, answer, and gold are required" },
      { status: 400 }
    )
  }

  const correct = await gradeAnswer(body.question, body.answer, body.gold, true)
  return NextResponse.json({ correct })
}
