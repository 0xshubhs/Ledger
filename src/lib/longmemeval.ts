import { readFile } from "fs/promises"
import { complete, judgeModel } from "./llm"

/**
 * LongMemEval instance shape (xiaowu0162/LongMemEval, ICLR 2025).
 *
 * One instance is a self-contained memory task: a haystack of chat sessions,
 * a question, and a gold answer. `question_id` ending in `_abs` marks an
 * abstention question, where the correct behaviour is to say the answer is not
 * in the history rather than to produce one.
 */
export interface LongMemEvalTurn {
  role: "user" | "assistant"
  content: string
  /** Present on turns carrying the evidence, used for turn-level recall. */
  has_answer?: boolean
}

export interface LongMemEvalInstance {
  question_id: string
  question_type:
    | "single-session-user"
    | "single-session-assistant"
    | "single-session-preference"
    | "temporal-reasoning"
    | "knowledge-update"
    | "multi-session"
  question: string
  answer: string
  question_date: string
  haystack_session_ids: string[]
  haystack_dates: string[]
  haystack_sessions: LongMemEvalTurn[][]
  answer_session_ids: string[]
}

export function isAbstention(instance: LongMemEvalInstance): boolean {
  return instance.question_id.endsWith("_abs")
}

/**
 * Parses LongMemEval's timestamp format — `2023/05/20 (Sat) 02:21`. The weekday
 * in parentheses is not something Date.parse accepts, so it's stripped first.
 * Ordering matters more than absolute correctness here: temporal-reasoning
 * questions are scored on whether the graph preserved session order.
 */
export function parseHaystackDate(raw: string, fallbackIndex: number): number {
  const cleaned = raw?.replace(/\s*\([A-Za-z]{3}\)\s*/, " ").trim() ?? ""
  const normalized = cleaned.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3").replace(" ", "T")

  const parsed = Date.parse(normalized)
  if (!Number.isNaN(parsed)) return parsed

  const loose = Date.parse(cleaned)
  if (!Number.isNaN(loose)) return loose

  // Keep sessions strictly ordered even when a date is unparseable, so the
  // validity intervals a knowledge-update question depends on stay monotonic.
  return Date.UTC(2024, 0, 1) + fallbackIndex * 86_400_000
}

export async function loadDataset(path: string): Promise<LongMemEvalInstance[]> {
  const raw = await readFile(path, "utf8")
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array of instances in ${path}`)
  }
  return parsed as LongMemEvalInstance[]
}

export interface DatasetFilter {
  limit?: number
  /** Skip this many matching instances first — used to resume a long run. */
  offset?: number
  questionTypes?: string[]
  /** Run exactly these question ids, ignoring the other filters' ordering. */
  questionIds?: string[]
  /** Include abstention questions. Default true — abstention is the headline claim. */
  includeAbstention?: boolean
  /** Only abstention questions, for isolating that metric. */
  onlyAbstention?: boolean
}

export function selectInstances(
  instances: LongMemEvalInstance[],
  filter: DatasetFilter = {}
): LongMemEvalInstance[] {
  const {
    limit,
    offset = 0,
    questionTypes,
    questionIds,
    includeAbstention = true,
    onlyAbstention = false,
  } = filter

  if (questionIds?.length) {
    const wanted = new Set(questionIds)
    return instances.filter((i) => wanted.has(i.question_id))
  }

  let selected = instances
  if (questionTypes?.length) {
    const wanted = new Set(questionTypes)
    selected = selected.filter((i) => wanted.has(i.question_type))
  }
  if (onlyAbstention) {
    selected = selected.filter(isAbstention)
  } else if (!includeAbstention) {
    selected = selected.filter((i) => !isAbstention(i))
  }

  selected = selected.slice(offset)
  return typeof limit === "number" ? selected.slice(0, limit) : selected
}

const JUDGE_SYSTEM = `You grade a memory system's answer against a gold answer.

Reply with exactly one word: CORRECT or INCORRECT.

Grade on semantic equivalence, not wording. A different phrasing, unit format,
or level of detail is CORRECT as long as it conveys the same fact and does not
add a contradicting claim. A partially correct answer that omits a specific the
gold answer requires is INCORRECT.`

/**
 * Cheap grader used before spending a judge call: exact or containment match
 * after normalisation. LongMemEval's own metric is LLM-as-judge, so this is
 * only a shortcut for the unambiguous cases.
 */
export function looksCorrect(answer: string, gold: string): boolean {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim()

  const a = normalize(answer)
  const g = normalize(gold)
  if (!a || !g) return false
  return a === g || a.includes(g) || g.includes(a)
}

/** Grades one answer, falling back to an LLM judge when string matching is inconclusive. */
export async function gradeAnswer(
  question: string,
  answer: string,
  gold: string,
  useJudge = true
): Promise<boolean> {
  if (looksCorrect(answer, gold)) return true
  if (!useJudge) return false

  // maxTokens is generous rather than 16: a local model may emit a reasoning
  // block before the verdict, and truncating mid-<think> would lose the answer
  // entirely. stripReasoning in llm.ts removes it before we read the verdict.
  const text = (
    await complete({
      system: JUDGE_SYSTEM,
      user: `Question: ${question}\nGold answer: ${gold}\nSystem answer: ${answer}`,
      maxTokens: 1024,
      model: judgeModel(),
    })
  ).toUpperCase()

  // Order matters: "INCORRECT" contains "CORRECT", so the negative is checked first.
  if (text.includes("INCORRECT")) return false
  return text.includes("CORRECT")
}

export interface InstanceResult {
  questionId: string
  questionType: string
  isAbstention: boolean
  question: string
  goldAnswer: string
  systemAnswer: string | null
  abstained: boolean
  correct: boolean
  /** Did retrieval surface a fact from a session the gold labels as evidence? */
  sessionRecall: boolean | null
  retrievalPath: string
  sessionsIngested: number
  factsWritten: number
  ingestMs: number
  queryMs: number
  error?: string
}

export interface EvalSummary {
  total: number
  correct: number
  accuracy: number
  byQuestionType: Record<string, { total: number; correct: number; accuracy: number }>
  abstention: { total: number; correct: number; accuracy: number }
  answerable: { total: number; correct: number; accuracy: number }
  sessionRecall: { evaluated: number; hits: number; recall: number }
  totalIngestMs: number
  totalQueryMs: number
  errors: number
}

export function summarize(results: InstanceResult[]): EvalSummary {
  const byQuestionType: EvalSummary["byQuestionType"] = {}
  let correct = 0
  let absTotal = 0
  let absCorrect = 0
  let ansTotal = 0
  let ansCorrect = 0
  let recallEvaluated = 0
  let recallHits = 0
  let totalIngestMs = 0
  let totalQueryMs = 0
  let errors = 0

  for (const r of results) {
    const bucket = (byQuestionType[r.questionType] ??= { total: 0, correct: 0, accuracy: 0 })
    bucket.total++
    if (r.correct) {
      bucket.correct++
      correct++
    }

    if (r.isAbstention) {
      absTotal++
      if (r.correct) absCorrect++
    } else {
      ansTotal++
      if (r.correct) ansCorrect++
    }

    if (r.sessionRecall !== null) {
      recallEvaluated++
      if (r.sessionRecall) recallHits++
    }

    totalIngestMs += r.ingestMs
    totalQueryMs += r.queryMs
    if (r.error) errors++
  }

  for (const bucket of Object.values(byQuestionType)) {
    bucket.accuracy = bucket.total ? bucket.correct / bucket.total : 0
  }

  return {
    total: results.length,
    correct,
    accuracy: results.length ? correct / results.length : 0,
    byQuestionType,
    abstention: { total: absTotal, correct: absCorrect, accuracy: absTotal ? absCorrect / absTotal : 0 },
    answerable: { total: ansTotal, correct: ansCorrect, accuracy: ansTotal ? ansCorrect / ansTotal : 0 },
    sessionRecall: {
      evaluated: recallEvaluated,
      hits: recallHits,
      recall: recallEvaluated ? recallHits / recallEvaluated : 0,
    },
    totalIngestMs,
    totalQueryMs,
    errors,
  }
}
