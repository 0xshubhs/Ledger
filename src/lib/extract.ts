import Anthropic from "@anthropic-ai/sdk"
import type { ExtractedFact } from "./memory"

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const EXTRACTION_PROMPT = `Extract durable facts about the user from this conversation transcript.

Return a JSON array only, no prose, no markdown fences. Each element:
{
  "subject": string,   // usually "user", or a named entity
  "predicate": string, // short relation, e.g. "prefers", "works_at", "lives_in"
  "object": string,    // the value
  "entities": string[] // proper nouns / named entities mentioned in this fact
}

Only extract facts that would matter to recall in a future conversation
(preferences, decisions, biographical details, ongoing projects). Skip small
talk. If nothing durable is stated, return [].

Transcript:
`

/** Extracts durable subject/predicate/object facts from a session transcript. */
export async function extractFacts(transcript: string): Promise<ExtractedFact[]> {
  const message = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 2048,
    messages: [{ role: "user", content: `${EXTRACTION_PROMPT}${transcript}` }],
  })

  const textBlock = message.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text"
  )
  if (!textBlock) return []

  const jsonMatch = textBlock.text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[0])
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (f): f is ExtractedFact =>
        typeof f?.subject === "string" &&
        typeof f?.predicate === "string" &&
        typeof f?.object === "string" &&
        Array.isArray(f?.entities)
    )
  } catch {
    return []
  }
}
