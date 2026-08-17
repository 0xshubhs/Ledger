import {
  ingestSession,
  getCurrentFact,
  getFactHistory,
  getFactsAboutEntity,
  type FactRow,
  type IngestMessage,
} from "./memory"
import { extractFacts, planQuery, synthesizeAnswer } from "./extract"
import {
  gradeAnswer,
  isAbstention,
  parseHaystackDate,
  type InstanceResult,
  type LongMemEvalInstance,
} from "./longmemeval"

export interface RunOptions {
  /** Grade with the LLM judge when string matching is inconclusive. */
  useJudge?: boolean
  /** Sessions ingested concurrently. Extraction is the bottleneck, not the graph. */
  concurrency?: number
  onProgress?: (message: string) => void
}

/**
 * Runs one LongMemEval instance end-to-end: ingest its haystack into the graph,
 * ask the question through the normal retrieval path, grade the answer.
 *
 * Each instance is namespaced under its own `question_id` as the user id, so
 * haystacks never bleed into one another — 500 instances share one graph
 * without cross-contamination, and a single instance can be re-run in isolation.
 */
export async function runInstance(
  instance: LongMemEvalInstance,
  options: RunOptions = {}
): Promise<InstanceResult> {
  const { useJudge = true, concurrency = 4, onProgress } = options
  const userExternalId = instance.question_id
  const abstention = isAbstention(instance)

  const base: InstanceResult = {
    questionId: instance.question_id,
    questionType: instance.question_type,
    isAbstention: abstention,
    question: instance.question,
    goldAnswer: instance.answer,
    systemAnswer: null,
    abstained: false,
    correct: false,
    sessionRecall: null,
    retrievalPath: "none",
    sessionsIngested: 0,
    factsWritten: 0,
    ingestMs: 0,
    queryMs: 0,
  }

  const ingestStart = Date.now()
  let factsWritten = 0

  try {
    const evidenceSessions = new Set(instance.answer_session_ids ?? [])
    const factSessionIndexes = new Set<number>()

    // Session timestamps come from haystack_dates so the graph's validity
    // intervals match the real chronology. Sessions arrive sorted in the S and M
    // variants, but the oracle variant is unsorted, so ordering is derived from
    // the parsed date rather than assumed from array position.
    const sessions = instance.haystack_sessions.map((turns, index) => ({
      index,
      sessionId: instance.haystack_session_ids?.[index] ?? `s${index}`,
      startedAt: parseHaystackDate(instance.haystack_dates?.[index] ?? "", index),
      turns,
    }))
    sessions.sort((a, b) => a.startedAt - b.startedAt)

    for (let offset = 0; offset < sessions.length; offset += concurrency) {
      const slice = sessions.slice(offset, offset + concurrency)
      const extracted = await Promise.all(
        slice.map(async (session) => {
          const messages: IngestMessage[] = session.turns.map((turn, i) => ({
            role: turn.role,
            content: turn.content,
            // One second per turn keeps turns ordered inside a session without
            // colliding with the next session's start.
            ts: session.startedAt + i * 1000,
          }))
          const facts = await extractFacts(messages)
          return { session, messages, facts }
        })
      )

      // Writes are sequential: a knowledge update has to observe the fact it
      // supersedes, and two concurrent writers on the same (subject, predicate)
      // would both read the same "current" row and each think they were first.
      for (const { session, messages, facts } of extracted) {
        const result = await ingestSession({
          userExternalId,
          sessionIndex: session.index,
          startedAt: session.startedAt,
          messages,
          facts,
        })
        factsWritten += result.factsWritten + result.factsSuperseded
        if (facts.length > 0 && evidenceSessions.has(session.sessionId)) {
          factSessionIndexes.add(session.index)
        }
      }

      onProgress?.(
        `${instance.question_id}: ingested ${Math.min(offset + concurrency, sessions.length)}/${sessions.length} sessions`
      )
    }

    base.sessionsIngested = sessions.length
    base.factsWritten = factsWritten
    base.ingestMs = Date.now() - ingestStart

    const queryStart = Date.now()
    const plan = await planQuery(instance.question)

    let facts: FactRow[] = []
    let retrievalPath = "none"

    if (plan.wantsHistory && plan.predicate) {
      facts = await getFactHistory(userExternalId, plan.subject, plan.predicate)
      if (facts.length) retrievalPath = "history"
    } else if (plan.predicate) {
      const current = await getCurrentFact(userExternalId, plan.subject, plan.predicate)
      if (current) {
        facts = [current]
        retrievalPath = "current"
      }
    }

    if (facts.length === 0 && plan.entities.length > 0) {
      const perEntity = await Promise.all(
        plan.entities.map((name) => getFactsAboutEntity(userExternalId, name))
      )
      const seen = new Set<number>()
      facts = perEntity.flat().filter((f) => !seen.has(f.id) && seen.add(f.id))
      if (facts.length) retrievalPath = "entity"
    }

    const { answer, abstained } = await synthesizeAnswer(instance.question, facts)
    base.queryMs = Date.now() - queryStart
    base.systemAnswer = answer
    base.abstained = abstained
    base.retrievalPath = retrievalPath

    // Session-level recall: did anything we retrieved originate in a session the
    // gold labels as evidence? Only meaningful for answerable questions.
    if (!abstention && evidenceSessions.size > 0) {
      base.sessionRecall = facts.some((f) => factSessionIndexes.has(f.sessionIndex))
    }

    // For an abstention question the correct behaviour *is* abstaining, so a
    // confident answer is wrong no matter how plausible it reads.
    if (abstention) {
      base.correct = abstained
    } else if (abstained || !answer) {
      base.correct = false
    } else {
      base.correct = await gradeAnswer(instance.question, answer, instance.answer, useJudge)
    }

    return base
  } catch (error) {
    base.error = (error as Error).message
    base.ingestMs = base.ingestMs || Date.now() - ingestStart
    return base
  }
}
