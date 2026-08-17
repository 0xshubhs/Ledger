import type { ExtractedFact, IngestMessage, FactRow } from "./memory"
import { complete } from "./llm"

const EXTRACTION_SYSTEM = `You extract durable facts from a chat transcript for a long-term memory store.

Return ONLY a JSON array, no prose and no markdown fences. Each element:
{
  "subject": string,              // usually "user", or a named entity
  "predicate": string,            // short snake_case relation: prefers, works_at, lives_in, decided
  "object": string,               // the value
  "entities": string[],           // proper nouns named in this fact
  "sourceMessageIndex": number    // 0-based index of the message that stated it
}

Rules:
- One fact per (subject, predicate) per distinct claim. Use the SAME predicate string
  when a later message revises an earlier claim, so the store can supersede it.
- Extract only what would matter to recall in a future conversation: preferences,
  decisions, biographical details, ongoing projects, commitments, constraints.
- Skip small talk, pleasantries, and anything the assistant asserted about itself.
- sourceMessageIndex must be the index shown as #N on the message that states the fact.
- Keep predicate under four words. "picked_up_during_trip_to_hobby_store" is too long;
  "bought" with the detail in object is right.
- Output a single JSON array. Do NOT prefix lines with turn numbers or emit one
  object per line.
- If nothing durable is stated, return [].`

/** Extracts durable subject/predicate/object facts from one session's messages. */
export async function extractFacts(messages: IngestMessage[]): Promise<ExtractedFact[]> {
  // Turn indices are marked with #N, not [N]. A local model shown [0] in the
  // input starts prefixing its output lines with [0] too, which turns the
  // expected JSON array into unparseable newline-delimited objects. Verified on
  // qwen3.5:4b, where it was the single largest cause of empty extractions.
  const transcript = messages.map((m, i) => `#${i} ${m.role}: ${m.content}`).join("\n")

  const text = await complete({
    system: EXTRACTION_SYSTEM,
    user: `Transcript:\n${transcript}`,
    maxTokens: 4096,
  })

  return parseFacts(text, messages.length)
}

/**
 * Pulls a fact list out of whatever the model actually produced.
 *
 * Three shapes are accepted, because local models reliably produce all three:
 *   1. a clean JSON array — the documented contract;
 *   2. an array wrapped in prose or markdown fences;
 *   3. newline-delimited objects, optionally prefixed with a turn marker, e.g.
 *      `[0] {"subject":...}` — smaller models drift into this when the input is
 *      line-numbered, and a first-bracket-to-last-bracket slice turns it into
 *      invalid JSON, silently yielding zero facts.
 */
export function parseFacts(text: string, messageCount: number): ExtractedFact[] {
  const candidates = extractObjects(text)
  return candidates.flatMap((raw): ExtractedFact[] => {
    const f = raw as Partial<ExtractedFact>
    if (
      typeof f?.subject !== "string" ||
      typeof f?.predicate !== "string" ||
      typeof f?.object !== "string"
    ) {
      return []
    }
    const index =
      typeof f.sourceMessageIndex === "number" &&
      f.sourceMessageIndex >= 0 &&
      f.sourceMessageIndex < messageCount
        ? f.sourceMessageIndex
        : undefined

    return [
      {
        subject: f.subject.trim(),
        predicate: f.predicate.trim(),
        object: f.object.trim(),
        entities: Array.isArray(f.entities) ? f.entities.filter((e) => typeof e === "string") : [],
        sourceMessageIndex: index,
      },
    ]
  })
}

/** Returns every plausible fact object in the text, whatever the wrapper. */
function extractObjects(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim()

  // Shape 1 and 2: a real JSON array somewhere in the text.
  const start = cleaned.indexOf("[")
  const end = cleaned.lastIndexOf("]")
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Fall through to the line-oriented reader.
    }
  }

  // Shape 3: one object per line, with any leading turn marker stripped. Also
  // covers a truncated array, where the last object is incomplete and the
  // whole-array parse above could never have succeeded.
  // Any leading marker is dropped by slicing from the line's first "{" rather
  // than matching a specific prefix pattern. Models echo whatever numbering the
  // input used — "[0]", "#0", "0.", "- " — and chasing each variant is a losing
  // game when the object itself is unambiguous.
  const objects: unknown[] = []
  for (const line of cleaned.split("\n")) {
    const open = line.indexOf("{")
    const close = line.lastIndexOf("}")
    if (open === -1 || close <= open) continue
    try {
      objects.push(JSON.parse(line.slice(open, close + 1)))
    } catch {
      // A single malformed line shouldn't discard the rest of the session.
    }
  }
  return objects
}

export interface QueryPlan {
  subject: string
  predicate: string
  /** True when the question asks about a past state rather than current truth. */
  wantsHistory: boolean
  entities: string[]
}

const PLAN_SYSTEM = `You translate a question into a lookup against a fact graph whose facts are
(subject, predicate, object) triples with validity intervals.

Return ONLY JSON, no prose, no fences:
{
  "subject": string,        // usually "user"
  "predicate": string,      // snake_case relation the question is asking about
  "wantsHistory": boolean,  // true if the question asks what was true BEFORE, or how something changed
  "entities": string[]      // proper nouns in the question, for multi-hop lookup
}`

/** Plans which graph lookup answers a natural-language question. */
export async function planQuery(question: string): Promise<QueryPlan> {
  const text = await complete({ system: PLAN_SYSTEM, user: question, maxTokens: 1024 })

  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  const fallback: QueryPlan = {
    subject: "user",
    predicate: "",
    wantsHistory: false,
    entities: [],
  }
  if (start === -1 || end <= start) return fallback

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<QueryPlan>
    return {
      subject: typeof parsed.subject === "string" ? parsed.subject : "user",
      predicate: typeof parsed.predicate === "string" ? parsed.predicate : "",
      wantsHistory: parsed.wantsHistory === true,
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.filter((e): e is string => typeof e === "string")
        : [],
    }
  } catch {
    return fallback
  }
}

const ANSWER_SYSTEM = `You answer a question using ONLY the retrieved facts supplied below.

Absolute rules:
- If the facts do not contain the answer, reply with exactly: NOT_IN_MEMORY
- Never use world knowledge or inference beyond what the facts state.
- Prefer facts marked CURRENT over ones marked SUPERSEDED unless the question
  explicitly asks what was true earlier.
- Answer in one short sentence, no preamble.`

export interface SynthesisResult {
  answer: string | null
  abstained: boolean
}

/**
 * Synthesises a final answer over the retrieved subgraph.
 *
 * Abstention is enforced on both sides: if retrieval returned nothing we never
 * call the model at all, and if it did we require the model to emit a sentinel
 * rather than guess. A vector store cannot make the first guarantee — nearest
 * neighbour always returns something, so "not in memory" is unreachable.
 */
export async function synthesizeAnswer(
  question: string,
  facts: FactRow[]
): Promise<SynthesisResult> {
  if (facts.length === 0) {
    return { answer: null, abstained: true }
  }

  const rendered = facts
    .map((f) => {
      const state = f.validTo === 0 ? "CURRENT" : `SUPERSEDED at ${f.validTo}`
      return `- (${f.subject}) ${f.predicate}: ${f.object} [${state}, from session ${f.sessionIndex}]`
    })
    .join("\n")

  const text = (
    await complete({
      system: ANSWER_SYSTEM,
      user: `Facts:\n${rendered}\n\nQuestion: ${question}`,
      maxTokens: 1024,
    })
  ).trim()

  if (!text || text.includes("NOT_IN_MEMORY")) {
    return { answer: null, abstained: true }
  }
  return { answer: text, abstained: false }
}
