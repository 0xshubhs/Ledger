#!/usr/bin/env node
/**
 * Measures the graph layer alone at real LongMemEval volume.
 *
 * Picks the instance with the most sessions in a split and ingests its whole
 * haystack with `facts: []`, so no extraction call is made. That isolates the
 * HydraDB write path from the LLM cost and answers one question: is the graph
 * the bottleneck in a full eval run, or is extraction?
 *
 *   node scripts/scale-check.mjs data/longmemeval_s.json
 *   node scripts/scale-check.mjs data/longmemeval_s.json http://localhost:3001
 */

import { readFile } from "node:fs/promises"

const path = process.argv[2]
const base = process.argv[3] ?? "http://localhost:3000"

if (!path) {
  console.error("usage: node scripts/scale-check.mjs <dataset.json> [baseUrl]")
  process.exit(1)
}

const data = JSON.parse(await readFile(path, "utf8"))

// Worst case, not average — the point is the ceiling.
const inst = data.reduce((a, b) =>
  b.haystack_sessions.length > a.haystack_sessions.length ? b : a
)
const turns = inst.haystack_sessions.reduce((n, s) => n + s.length, 0)
const chars = inst.haystack_sessions.flat().reduce((n, t) => n + t.content.length, 0)

console.log(`instance ${inst.question_id} (${inst.question_type})`)
console.log(
  `  sessions=${inst.haystack_sessions.length} turns=${turns} chars=${chars} (~${Math.round(chars / 4 / 1000)}K tokens)`
)

/** Same order-preserving parse as src/lib/longmemeval.ts. */
function parseDate(raw, i) {
  const cleaned = (raw ?? "").replace(/\s*\([A-Za-z]{3}\)\s*/, " ").trim()
  const norm = cleaned.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, "$1-$2-$3").replace(" ", "T")
  const parsed = Date.parse(norm)
  return Number.isNaN(parsed) ? Date.UTC(2024, 0, 1) + i * 86_400_000 : parsed
}

const startedAtRun = Date.now()
let messages = 0

for (let i = 0; i < inst.haystack_sessions.length; i++) {
  const startedAt = parseDate(inst.haystack_dates?.[i], i)
  const turnRows = inst.haystack_sessions[i].map((t, j) => ({
    role: t.role,
    content: t.content,
    ts: startedAt + j * 1000,
  }))

  const res = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userExternalId: `scale-${inst.question_id}`,
      sessionIndex: i,
      startedAt,
      messages: turnRows,
      facts: [],
    }),
  })

  const json = await res.json()
  if (!res.ok) {
    console.log(`  session ${i} FAILED: ${json.error}`)
    process.exit(1)
  }
  messages += json.messagesWritten

  if (i % 10 === 0 || i === inst.haystack_sessions.length - 1) {
    console.log(
      `  session ${i}: +${json.messagesWritten} msgs (${messages} total, ${((Date.now() - startedAtRun) / 1000).toFixed(1)}s)`
    )
  }
}

const elapsed = (Date.now() - startedAtRun) / 1000
const totalSessions = data.reduce((n, x) => n + x.haystack_sessions.length, 0)

console.log(
  `\ningested ${messages} messages across ${inst.haystack_sessions.length} sessions in ${elapsed.toFixed(1)}s`
)
console.log(`  ${(messages / elapsed).toFixed(0)} messages/sec`)
console.log(
  `  a full ${data.length}-question run is ${totalSessions} sessions ≈ ${((totalSessions / inst.haystack_sessions.length) * (elapsed / 60)).toFixed(0)} min of graph writes`
)
console.log(`  (plus one extraction call per session — that is the real cost)`)

const stats = await (await fetch(`${base}/api/stats`)).json()
console.log("  graph now:", JSON.stringify(stats))
