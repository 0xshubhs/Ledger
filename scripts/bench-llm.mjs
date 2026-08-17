#!/usr/bin/env node
/**
 * Measures extraction throughput on the configured LLM backend, using real
 * LongMemEval sessions as input.
 *
 * This is the number that decides which split is runnable locally. Extraction
 * is one call per session, so wall-clock for a full run is
 * (sessions x seconds-per-call), and the two official splits differ by 26x in
 * session count — 948 for oracle against 25,112 for S.
 *
 *   node scripts/bench-llm.mjs data/longmemeval_oracle.json
 *   node scripts/bench-llm.mjs data/longmemeval_oracle.json 12   # 12 samples
 */

import { readFile } from "node:fs/promises"

const datasetPath = process.argv[2] ?? "data/longmemeval_oracle.json"
const samples = Number(process.argv[3] ?? 8)
const base = process.env.EVAL_BASE_URL ?? "http://localhost:3001"

const health = await (await fetch(`${base}/api/health?llm=1`)).json().catch(() => null)
if (!health) {
  console.error(`Cannot reach ${base} — is 'npm run dev' running?`)
  process.exit(1)
}
if (health.llm?.ok === false) {
  console.error(`LLM not answering: ${health.llm.detail}`)
  process.exit(1)
}
console.log(
  `backend   ${health.llm.provider} · ${health.llm.model}${health.llm.baseUrl ? ` @ ${health.llm.baseUrl}` : ""}`
)

const data = JSON.parse(await readFile(datasetPath, "utf8"))

// Flatten to individual sessions and take a spread across the file rather than
// the first N, so one unusually short instance can't flatter the average.
const sessions = []
const stride = Math.max(1, Math.floor(data.length / samples))
for (let i = 0; i < data.length && sessions.length < samples; i += stride) {
  const inst = data[i]
  const turns = inst.haystack_sessions[0]
  if (turns?.length) sessions.push({ questionId: inst.question_id, turns })
}

console.log(`dataset   ${datasetPath}`)
console.log(`sampling  ${sessions.length} real sessions\n`)

const timings = []
let factsTotal = 0
let emptyExtractions = 0

for (let i = 0; i < sessions.length; i++) {
  const { questionId, turns } = sessions[i]
  const chars = turns.reduce((n, t) => n + t.content.length, 0)

  const startedAt = Date.now()
  const res = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userExternalId: `bench-${questionId}`,
      sessionIndex: 0,
      messages: turns.map((t, j) => ({
        role: t.role,
        content: t.content,
        ts: Date.UTC(2024, 0, 1) + j * 1000,
      })),
    }),
  })
  const elapsed = (Date.now() - startedAt) / 1000
  const body = await res.json().catch(() => ({}))

  if (!res.ok) {
    console.log(`  ${i + 1}/${sessions.length} FAILED: ${body.error ?? res.status}`)
    continue
  }

  timings.push({ elapsed, extractMs: body.extractMs ?? 0, chars, facts: body.factsExtracted ?? 0 })
  factsTotal += body.factsExtracted ?? 0
  if ((body.factsExtracted ?? 0) === 0) emptyExtractions++

  console.log(
    `  ${i + 1}/${sessions.length} ${turns.length} turns, ${chars} chars → ` +
      `${body.factsExtracted} facts in ${elapsed.toFixed(1)}s (extract ${((body.extractMs ?? 0) / 1000).toFixed(1)}s)`
  )
}

if (timings.length === 0) {
  console.error("\nNo successful samples.")
  process.exit(1)
}

const mean = timings.reduce((n, t) => n + t.elapsed, 0) / timings.length
const extractMean = timings.reduce((n, t) => n + t.extractMs, 0) / timings.length / 1000
const sorted = [...timings].map((t) => t.elapsed).sort((a, b) => a - b)
const median = sorted[Math.floor(sorted.length / 2)]

const totals = {}
for (const name of ["oracle", "s"]) {
  try {
    const d = JSON.parse(await readFile(`data/longmemeval_${name}.json`, "utf8"))
    totals[name] = d.reduce((n, x) => n + x.haystack_sessions.length, 0)
  } catch {
    // split not downloaded — skip its projection rather than fail the bench
  }
}

console.log(`\n${"=".repeat(62)}`)
console.log(`mean       ${mean.toFixed(1)}s per session  (extraction ${extractMean.toFixed(1)}s of it)`)
console.log(`median     ${median.toFixed(1)}s`)
console.log(`facts      ${factsTotal} total, ${(factsTotal / timings.length).toFixed(1)} per session`)
console.log(`empty      ${emptyExtractions}/${timings.length} sessions yielded no facts`)
console.log("-".repeat(62))
for (const [name, sessionCount] of Object.entries(totals)) {
  const hours = (sessionCount * mean) / 3600
  const label = hours < 1 ? `${(hours * 60).toFixed(0)} min` : `${hours.toFixed(1)} h`
  console.log(`${name.padEnd(10)} ${String(sessionCount).padStart(6)} sessions → ~${label} of extraction`)
}
console.log("=".repeat(62))
console.log(`\nAdd --concurrency N to run-eval to overlap extraction within an instance.`)
console.log(`A high empty-extraction count means the prompt or model needs work, not the graph.`)
