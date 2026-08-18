import {
  ingestSession,
  retrieveFacts,
  getProvenanceForFacts,
  getKnownPredicates,
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
  /**
   * Prefix for the user id each instance is stored under.
   *
   * Facts are never deleted on update, and `DETACH DELETE` becomes unusable on a
   * large graph (it scans relationships graph-wide and trips admission control
   * at a million), so a graph that has already seen a run cannot practically be
   * emptied. A tag gives the next run its own namespace instead, which is what
   * makes two runs of the same split comparable.
   */
  tag?: string
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
  const { useJudge = true, concurrency = 4, tag, onProgress } = options
  const userExternalId = tag ? `${tag}:${instance.question_id}` : instance.question_id
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
    factsUnchanged: 0,
    factsRetrieved: 0,
    ingestMs: 0,
    queryMs: 0,
  }

  const ingestStart = Date.now()
  let factsWritten = 0
  let factsUnchanged = 0

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

      // Refreshed each batch rather than once: the vocabulary a session should
      // reuse includes predicates written by the sessions before it, and a
      // haystack is ingested oldest-first, so the revision arrives after the
      // statement it revises.
      const knownPredicates = await getKnownPredicates(userExternalId)

      const extracted = await Promise.all(
        slice.map(async (session) => {
          const messages: IngestMessage[] = session.turns.map((turn, i) => ({
            role: turn.role,
            content: turn.content,
            // One second per turn keeps turns ordered inside a session without
            // colliding with the next session's start.
            ts: session.startedAt + i * 1000,
          }))
          const facts = await extractFacts(messages, knownPredicates)
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
        factsUnchanged += result.factsUnchanged
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
    base.factsUnchanged = factsUnchanged
    base.ingestMs = Date.now() - ingestStart

    const queryStart = Date.now()
    const plan = await planQuery(instance.question)

    const { facts, path: retrievalPath } = await retrieveFacts(userExternalId, plan)
    base.factsRetrieved = facts.length

    // The source turns for the most relevant facts. A triple flattens the
    // detail a LongMemEval answer is usually graded on ("GPS system not
    // functioning correctly"), and the sentence that stated it is one hop away
    // across ASSERTS.
    const provenance = await getProvenanceForFacts(facts)

    const { answer, abstained } = await synthesizeAnswer(instance.question, facts, provenance)
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
