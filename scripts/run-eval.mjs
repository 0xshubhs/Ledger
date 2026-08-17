#!/usr/bin/env node
/**
 * Drives a full LongMemEval run against a locally running dev server.
 *
 * A 500-question run ingests roughly 24,000 sessions and makes one extraction
 * call per session, so it is measured in hours and will die partway through at
 * least once. Results stream to a JSONL file as each instance finishes, and a
 * re-run skips whatever is already in that file — so an interrupted run is
 * resumed by invoking the same command again.
 *
 *   node scripts/run-eval.mjs --dataset data/longmemeval_s.json
 *   node scripts/run-eval.mjs --dataset data/longmemeval_s.json --limit 20
 *   node scripts/run-eval.mjs --dataset data/longmemeval_s.json --types knowledge-update
 *   node scripts/run-eval.mjs --dataset data/longmemeval_s.json --out results/s-run2.jsonl
 */

import { readFile, appendFile, mkdir } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

function parseArgs(argv) {
  const args = {
    base: process.env.EVAL_BASE_URL ?? "http://localhost:3001",
    dataset: process.env.LONGMEMEVAL_PATH,
    out: "results/longmemeval.jsonl",
    limit: Infinity,
    types: null,
    concurrency: 4,
    noJudge: false,
    onlyAbstention: false,
  }
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    const next = () => argv[++i]
    if (arg === "--dataset") args.dataset = next()
    else if (arg === "--out") args.out = next()
    else if (arg === "--base") args.base = next()
    else if (arg === "--limit") args.limit = Number(next())
    else if (arg === "--types") args.types = next().split(",")
    else if (arg === "--concurrency") args.concurrency = Number(next())
    else if (arg === "--no-judge") args.noJudge = true
    else if (arg === "--only-abstention") args.onlyAbstention = true
    else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  if (!args.dataset) {
    console.error("--dataset <path> is required (or set LONGMEMEVAL_PATH)")
    process.exit(1)
  }
  return args
}

/** Question ids already recorded in the output file, so a resume skips them. */
function alreadyDone(path) {
  if (!existsSync(path)) return new Set()
  const done = new Set()
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.questionId) done.add(row.questionId)
    } catch {
      // A partial final line from a killed process — ignore it and re-run that one.
    }
  }
  return done
}

function summarize(results) {
  const byType = {}
  let correct = 0
  let absTotal = 0
  let absCorrect = 0
  let ansTotal = 0
  let ansCorrect = 0
  let recallEval = 0
  let recallHits = 0

  for (const r of results) {
    const bucket = (byType[r.questionType] ??= { total: 0, correct: 0 })
    bucket.total++
    if (r.correct) {
      bucket.correct++
      correct++
    }
    if (r.isAbstention) {
      absTotal++
      if (r.correct) absCorrect++
    } else {
      ansTotal++
      if (r.correct) ansCorrect++
    }
    if (r.sessionRecall !== null && r.sessionRecall !== undefined) {
      recallEval++
      if (r.sessionRecall) recallHits++
    }
  }

  const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "n/a")

  console.log("\n" + "=".repeat(64))
  console.log(`Overall            ${correct}/${results.length}  ${pct(correct, results.length)}`)
  console.log(`Answerable         ${ansCorrect}/${ansTotal}  ${pct(ansCorrect, ansTotal)}`)
  console.log(`Abstention         ${absCorrect}/${absTotal}  ${pct(absCorrect, absTotal)}`)
  console.log(`Session recall     ${recallHits}/${recallEval}  ${pct(recallHits, recallEval)}`)
  console.log("-".repeat(64))
  for (const [type, b] of Object.entries(byType).sort()) {
    console.log(`${type.padEnd(30)} ${b.correct}/${b.total}  ${pct(b.correct, b.total)}`)
  }
  console.log("=".repeat(64))
}

const args = parseArgs(process.argv)

/**
 * Fail fast on the two things that make every instance fail identically: an
 * unreachable dev server, and a missing API key. Without this, a full run
 * cheerfully burns through 500 instances writing the same error to each row,
 * and only the summary at the end reveals that nothing was actually evaluated.
 */
async function preflight() {
  let health, body
  try {
    health = await fetch(`${args.base}/api/health?llm=1`)
    body = await health.json()
  } catch {
    console.error(`Cannot reach ${args.base} — is 'npm run dev' running?`)
    console.error(`(override with --base or EVAL_BASE_URL if it's on another port)`)
    process.exit(1)
  }

  if (body?.llm) {
    const l = body.llm
    console.log(
      `llm          ${l.provider} · ${l.model}${l.baseUrl ? ` @ ${l.baseUrl}` : ""}` +
        (l.judgeModel && l.judgeModel !== l.model ? ` · judge ${l.judgeModel}` : "")
    )
  }

  if (body?.healthy === false) {
    console.error(`\nThe HydraDB graph-node is unreachable.`)
    console.error(`Start a node — see README, section "Setup".`)
    process.exit(1)
  }
  if (body?.llm?.ok === false) {
    console.error(`\nLLM backend not answering: ${body.llm.detail}`)
    if (body.llm.provider === "openai-compatible") {
      console.error(`\nFor Ollama:  ollama serve  &&  ollama pull ${body.llm.model}`)
      console.error(`For localAI: python3 serve.py, then set LLM_BASE_URL=http://localhost:8080/v1`)
    } else {
      console.error(`\nCheck ANTHROPIC_API_KEY in .env.local.`)
    }
    process.exit(1)
  }

  // One real instance through the pipeline. If the key is missing or wrong, the
  // runner reports it here rather than 500 rows later.
  const probe = await fetch(`${args.base}/api/eval`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ datasetPath: args.dataset, limit: 1, concurrency: 1 }),
  })
  const probeBody = await probe.json().catch(() => ({}))
  if (!probe.ok) {
    console.error(`Preflight failed (HTTP ${probe.status}): ${probeBody.error ?? "unknown"}`)
    process.exit(1)
  }
  const err = probeBody.results?.[0]?.error
  if (err) {
    console.error(`Preflight failed: ${err}`)
    console.error(`\nSee .env.example for LLM backend options (local Ollama / localAI, or Claude).`)
    process.exit(1)
  }
  console.log(`preflight    ok (one instance ran end-to-end)\n`)
}

await preflight()

const dataset = JSON.parse(await readFile(args.dataset, "utf8"))
const done = alreadyDone(args.out)

let pending = dataset
if (args.types) {
  const wanted = new Set(args.types)
  pending = pending.filter((i) => wanted.has(i.question_type))
}
if (args.onlyAbstention) {
  pending = pending.filter((i) => i.question_id.endsWith("_abs"))
}
pending = pending.filter((i) => !done.has(i.question_id))
if (Number.isFinite(args.limit)) pending = pending.slice(0, args.limit)

await mkdir(dirname(args.out), { recursive: true })

console.log(`dataset      ${args.dataset} (${dataset.length} instances)`)
console.log(`already done ${done.size}`)
console.log(`this run     ${pending.length}`)
console.log(`output       ${args.out}\n`)

const results = []
let index = 0

for (const instance of pending) {
  index++
  const label = `[${index}/${pending.length}] ${instance.question_id} (${instance.question_type})`
  const startedAt = Date.now()

  try {
    const res = await fetch(`${args.base}/api/eval`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        datasetPath: args.dataset,
        questionIds: [instance.question_id],
        useJudge: !args.noJudge,
        concurrency: args.concurrency,
      }),
    })

    if (!res.ok) {
      console.log(`${label} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      continue
    }

    const body = await res.json()
    const result = body.results?.[0]
    if (!result) {
      console.log(`${label} no result returned`)
      continue
    }

    results.push(result)
    await appendFile(args.out, JSON.stringify(result) + "\n")

    const mark = result.correct ? "PASS" : "FAIL"
    // Report what retrieval had, not just what this run wrote: re-running over
    // an already-populated graph writes nothing and would otherwise print
    // "0 facts", which reads as an extraction failure rather than a cache hit.
    const detail = result.error
      ? `error: ${result.error}`
      : `${result.sessionsIngested} sessions, ${result.factsRetrieved} facts retrieved` +
        ` (+${result.factsWritten} new, ${result.factsUnchanged} unchanged), via ${result.retrievalPath}`
    console.log(`${label} ${mark} ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${detail}`)
  } catch (error) {
    console.log(`${label} request failed: ${error.message}`)
  }
}

// Summarise everything on disk, not just this run's slice, so a resumed run
// still reports the full picture.
const all = existsSync(args.out)
  ? readFileSync(args.out, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l)]
        } catch {
          return []
        }
      })
  : results

summarize(all)
