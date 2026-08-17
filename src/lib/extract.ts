import Anthropic from "@anthropic-ai/sdk"
import type { ExtractedFact, IngestMessage, FactRow } from "./memory"

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5"

let cached: Anthropic | null = null

/** Lazily constructed so importing this module doesn't require a key at build time. */
function client(): Anthropic {
  if (!cached) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY environment variable")
    cached = new Anthropic({ apiKey })
  }
  return cached
}

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
- sourceMessageIndex must be the index of the message that actually states the fact.
- If nothing durable is stated, return [].`

/** Extracts durable subject/predicate/object facts from one session's messages. */
export async function extractFacts(messages: IngestMessage[]): Promise<ExtractedFact[]> {
  const transcript = messages
    .map((m, i) => `[${i}] ${m.role}: ${m.content}`)
    .join("\n")

  const message = await client().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM,
    messages: [{ role: "user", content: `Transcript:\n${transcript}` }],
  })

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")

  return parseFacts(text, messages.length)
}

/** Defensive parse — a model that wraps its JSON or trails prose shouldn't fail ingest. */
export function parseFacts(text: string, messageCount: number): ExtractedFact[] {
  const start = text.indexOf("[")
  const end = text.lastIndexOf("]")
  if (start === -1 || end <= start) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  return parsed.flatMap((raw): ExtractedFact[] => {
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
  const message = await client().messages.create({
    model: MODEL,
    max_tokens: 512,
    system: PLAN_SYSTEM,
    messages: [{ role: "user", content: question }],
  })

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")

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

  const message = await client().messages.create({
    model: MODEL,
    max_tokens: 512,
    system: ANSWER_SYSTEM,
    messages: [{ role: "user", content: `Facts:\n${rendered}\n\nQuestion: ${question}` }],
  })

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim()

  if (!text || text.includes("NOT_IN_MEMORY")) {
    return { answer: null, abstained: true }
  }
  return { answer: text, abstained: false }
}
