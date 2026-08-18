import type { ExtractedFact, IngestMessage, FactRow, ProvenanceRow } from "./memory"
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
- Extract anything a future conversation might need to recall:
  * preferences, decisions, biographical details, ongoing projects, commitments
  * events that happened, with what happened to whom — appointments, trips,
    purchases, repairs, meetings, deadlines
  * problems, faults, symptoms and complaints ("the GPS stopped working"),
    including how they were resolved
  * quantities, dates and durations the user mentions
  Be generous: a fact that is never asked about costs nothing, and a fact that was
  never extracted cannot be recalled at all.
- Skip small talk, pleasantries, and anything the assistant asserted about itself.
- sourceMessageIndex must be the index shown as #N on the message that states the fact.
- Keep predicate under four words. "picked_up_during_trip_to_hobby_store" is too long;
  "bought" with the detail in object is right.
- Output a single JSON array. Do NOT prefix lines with turn numbers or emit one
  object per line.
- If nothing durable is stated, return [].`

/**
 * Extracts durable subject/predicate/object facts from one session's messages.
 *
 * `knownPredicates` is the vocabulary already in the graph for this user. It is
 * passed in the user message rather than the system prompt because it changes
 * per call, and it exists to make revisions detectable: supersede is keyed on
 * (subject, predicate), so an update only closes the old fact if the extractor
 * reaches for the same relation name. Left to itself the model writes
 * `ran_charity_5K_in` one session and `has_personal_best_time` the next, and
 * both survive as current truth with nothing linking them.
 */
export async function extractFacts(
  messages: IngestMessage[],
  knownPredicates: string[] = []
): Promise<ExtractedFact[]> {
  // Turn indices are marked with #N, not [N]. A local model shown [0] in the
  // input starts prefixing its output lines with [0] too, which turns the
  // expected JSON array into unparseable newline-delimited objects. Verified on
  // qwen3.5:4b, where it was the single largest cause of empty extractions.
  const transcript = messages.map((m, i) => `#${i} ${m.role}: ${m.content}`).join("\n")

  const vocabulary = knownPredicates.length
    ? `Relation names already stored for this user:\n${knownPredicates.join(", ")}\n\n` +
      `If a statement below updates or restates one of those, reuse that exact name.\n\n`
    : ""

  const text = await complete({
    system: EXTRACTION_SYSTEM,
    user: `${vocabulary}Transcript:\n${transcript}`,
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

const ANSWER_SYSTEM = `You answer a question using ONLY the retrieved memory supplied below.

Each fact carries the date it was stated and, where available, the exact sentence
the user or assistant said. Quotes are evidence, not decoration — if the question
asks for a detail the triple flattened away, take it from the quote.

Absolute rules:
- Use the dates to answer ordering questions ("which came first", "how long
  after", "what did I do before X"). The facts are listed oldest first.
- If the memory does not contain the answer, reply with exactly: NOT_IN_MEMORY
- Do not answer from world knowledge, and do not guess at a fact that is absent.
  But do answer when the memory supports it: an answer that is present and not
  given is as wrong as one that is invented.
- Prefer facts marked CURRENT over ones marked SUPERSEDED unless the question
  explicitly asks what was true earlier.
- When two facts state different values for the same thing, the one with the
  LATER date is what is true now — people revise what they told you. Answer with
  the latest value unless the question asks what it used to be. This holds even
  when both are marked CURRENT: the store only marks a fact superseded when the
  update reused the same relation name, and a later contradiction is still an
  update.
- Relation names are written by an extractor, not by the user, so the one whose
  wording is closest to the question is not necessarily the one that answers it.
  Read every fact and quote before answering, and for "current", "latest", "now"
  or "personal best" questions take the most recent qualifying value rather than
  the first plausible-looking match.
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
  facts: FactRow[],
  provenance?: Map<number, ProvenanceRow[]>
): Promise<SynthesisResult> {
  if (facts.length === 0) {
    return { answer: null, abstained: true }
  }

  const rendered = renderFacts(facts, provenance)

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

/** ISO day, which is the granularity LongMemEval's temporal questions ask at. */
function day(ts: number): string {
  return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : "undated"
}

/**
 * Renders the retrieved subgraph for the answer model, oldest first.
 *
 * The date is the part that matters most and was previously missing: a fact list
 * carrying only `session 3` cannot answer "which did I do first", and 133 of
 * LongMemEval's 500 questions are temporal. `valid_from` is stamped from the
 * asserting turn, so it is the real chronology rather than ingest order.
 */
export function renderFacts(facts: FactRow[], provenance?: Map<number, ProvenanceRow[]>): string {
  return [...facts]
    .sort((a, b) => a.validFrom - b.validFrom)
    .map((f) => {
      const state = f.validTo === 0 ? "CURRENT" : `SUPERSEDED on ${day(f.validTo)}`
      const head = `- [${day(f.validFrom)}] (${f.subject}) ${f.predicate}: ${f.object} [${state}]`
      const quotes = provenance?.get(f.id) ?? []
      if (quotes.length === 0) return head
      return [
        head,
        ...quotes.map((q) => `    "${q.content.replace(/\s+/g, " ").slice(0, 400)}" — ${q.role}`),
      ].join("\n")
    })
    .join("\n")
}
