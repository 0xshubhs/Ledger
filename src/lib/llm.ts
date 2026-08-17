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
  choices?: { message?: { content?: string } }[]
  error?: { message?: string } | string
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

  return stripReasoning(parsed.choices?.[0]?.message?.content ?? "")
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
}

export function describeProvider(): ProviderInfo {
  const p = provider()
  return {
    provider: p,
    model: defaultModel(),
    judgeModel: judgeModel(),
    ...(p === "openai-compatible" ? { baseUrl: baseUrl() } : {}),
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
