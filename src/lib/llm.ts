import Anthropic from "@anthropic-ai/sdk"

/**
 * One text-completion interface over two backends, so the memory layer and the
 * eval harness don't care which one is running:
 *
 *  - `anthropic`         — the Claude API via @anthropic-ai/sdk.
 *  - `openai-compatible` — any server exposing POST /v1/chat/completions.
 *                          Ollama does this at :11434/v1, and llama.cpp's
 *                          llama-server (including the TurboQuant build in
 *                          ../localAI) does it at :8080/v1. Same code path for
 *                          both — only LLM_BASE_URL changes.
 *
 * The provider is chosen by LLM_PROVIDER, or inferred: if ANTHROPIC_API_KEY is
 * present we use Claude, otherwise we assume a local OpenAI-compatible server.
 * That inference is deliberate — it means a machine with no key runs locally by
 * default rather than failing at the first call.
 */

export type Provider = "anthropic" | "openai-compatible"

export interface CompletionRequest {
  system: string
  user: string
  maxTokens?: number
  /** Ask the server to constrain output to JSON, where it supports it. */
  json?: boolean
  /** Override the configured model for this one call (used by the eval judge). */
  model?: string
}

function env(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

export function provider(): Provider {
  const explicit = env("LLM_PROVIDER")
  if (explicit === "anthropic" || explicit === "openai-compatible") return explicit
  return env("ANTHROPIC_API_KEY") ? "anthropic" : "openai-compatible"
}

/** Base URL of the local server. Ollama's OpenAI shim lives under /v1. */
export function baseUrl(): string {
  return (env("LLM_BASE_URL") ?? "http://localhost:11434/v1").replace(/\/$/, "")
}

export function defaultModel(): string {
  if (provider() === "anthropic") return env("LLM_MODEL") ?? "claude-sonnet-5"
  return env("LLM_MODEL") ?? "qwen3.5:4b"
}

/** The grader's model. Kept separate so a run can be judged by a different one. */
export function judgeModel(): string {
  return env("LLM_JUDGE_MODEL") ?? defaultModel()
}

/**
 * Strips reasoning traces that instruction-tuned local models emit before their
 * answer. Qwen3.x and several others wrap these in <think>…</think>; without
 * removing them, JSON extraction sees prose first and a naive parse fails. An
 * unterminated opening tag means the model ran out of tokens mid-thought, so
 * everything after it is discarded too.
 */
export function stripReasoning(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "")
  const dangling = out.search(/<think>/i)
  if (dangling !== -1) out = out.slice(0, dangling)
  return out.replace(/^\s*<\/think>/i, "").trim()
}

let anthropicClient: Anthropic | null = null

function anthropic(): Anthropic {
  if (!anthropicClient) {
    const apiKey = env("ANTHROPIC_API_KEY")
    if (!apiKey) throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set")
    anthropicClient = new Anthropic({ apiKey })
  }
  return anthropicClient
}

interface ChatCompletionResponse {
  choices?: {
    message?: {
      content?: string
      /** Ollama returns a hybrid model's chain-of-thought here, out of `content`. */
      reasoning?: string
      reasoning_content?: string
    }
    finish_reason?: string
  }[]
  usage?: { completion_tokens?: number }
  error?: { message?: string } | string
}

/**
 * Reasoning models are actively harmful for this workload and the failure is
 * silent, so this defaults to off.
 *
 * Measured on qwen3.5:4b through Ollama, extracting facts from one session:
 *
 *   default (thinking on)     29.2s — 800 completion tokens, ALL of them
 *                                    reasoning, `content` empty, 0 facts
 *   reasoning_effort: "none"   0.9s — 34 tokens, 2 facts, correct JSON
 *
 * A hybrid model spends its entire token budget deliberating and never reaches
 * the answer, and because Ollama puts that text in a separate `reasoning` field
 * the response still looks well-formed — just with empty content. Over 948
 * sessions that is 8 hours of compute producing an empty graph.
 *
 * Note that `think: false` and `chat_template_kwargs: {enable_thinking: false}`
 * are both silently ignored on Ollama's /v1 endpoint (verified: still 800
 * reasoning tokens, still empty content). `reasoning_effort` is the one that
 * works. Set LLM_REASONING_EFFORT to override — "low"/"medium"/"high" if a
 * model genuinely needs to deliberate, or "" to omit the field entirely for a
 * server that rejects it.
 */
function reasoningEffort(): string | undefined {
  const configured = process.env.LLM_REASONING_EFFORT
  if (configured === undefined) return "none"
  return configured.length > 0 ? configured : undefined
}

async function completeOpenAICompatible(req: CompletionRequest): Promise<string> {
  const model = req.model ?? defaultModel()
  const url = `${baseUrl()}/chat/completions`

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    max_tokens: req.maxTokens ?? 2048,
    // Extraction and grading want the same answer every time for the same
    // input; sampling only adds variance to a benchmark number.
    temperature: 0,
    stream: false,
  }
  if (req.json) {
    body.response_format = { type: "json_object" }
  }
  const effort = reasoningEffort()
  if (effort) body.reasoning_effort = effort

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const apiKey = env("LLM_API_KEY")
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  const text = await res.text()

  let parsed: ChatCompletionResponse
  try {
    parsed = JSON.parse(text) as ChatCompletionResponse
  } catch {
    throw new Error(`${url} returned non-JSON (${res.status}): ${text.slice(0, 300)}`)
  }

  if (!res.ok) {
    const message =
      typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? text.slice(0, 300)
    // A local server that is up but has never seen this model says so here,
    // which is a much more useful message than a generic 4xx.
    throw new Error(`${model} at ${url} failed (${res.status}): ${message}`)
  }

  const choice = parsed.choices?.[0]
  const content = choice?.message?.content ?? ""

  // Empty content with a populated reasoning field means the model deliberated
  // until it hit max_tokens and never emitted an answer. Silently returning ""
  // would look like "no facts found" and quietly produce an empty graph over
  // thousands of sessions, so it's an error with the actual cause named.
  if (!content.trim()) {
    const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content ?? ""
    if (reasoning.trim()) {
      throw new Error(
        `${model} spent all ${parsed.usage?.completion_tokens ?? "?"} completion tokens on ` +
          `reasoning and returned no answer. Set LLM_REASONING_EFFORT=none (the default), ` +
          `or use a non-reasoning model.`
      )
    }
    if (choice?.finish_reason === "length") {
      throw new Error(`${model} hit the ${req.maxTokens ?? 2048}-token limit before answering.`)
    }
  }

  return stripReasoning(content)
}

async function completeAnthropic(req: CompletionRequest): Promise<string> {
  const message = await anthropic().messages.create({
    model: req.model ?? defaultModel(),
    max_tokens: req.maxTokens ?? 2048,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
  })

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")

  return stripReasoning(text)
}

/** Runs one completion against whichever backend is configured. */
export async function complete(req: CompletionRequest): Promise<string> {
  return provider() === "anthropic"
    ? completeAnthropic(req)
    : completeOpenAICompatible(req)
}

export interface ProviderInfo {
  provider: Provider
  model: string
  judgeModel: string
  baseUrl?: string
  reasoningEffort?: string
}

export function describeProvider(): ProviderInfo {
  const p = provider()
  return {
    provider: p,
    model: defaultModel(),
    judgeModel: judgeModel(),
    ...(p === "openai-compatible"
      ? { baseUrl: baseUrl(), reasoningEffort: reasoningEffort() ?? "(omitted)" }
      : {}),
  }
}

/**
 * Confirms the configured backend can actually answer, so a long run fails in
 * one second rather than after several hundred identical errors.
 */
export async function checkLlm(): Promise<{ ok: boolean; detail: string }> {
  try {
    const reply = await complete({
      system: "Reply with the single word OK.",
      user: "ping",
      maxTokens: 2048,
    })
    const trimmed = reply.trim()
    return trimmed
      ? { ok: true, detail: trimmed.slice(0, 80) }
      : { ok: false, detail: "empty response" }
  } catch (error) {
    return { ok: false, detail: (error as Error).message }
  }
}
