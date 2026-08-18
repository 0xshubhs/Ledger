#!/usr/bin/env node
/**
 * Second-pass grading for a finished run.
 *
 * `run-eval.mjs --no-judge` grades by normalised string match only, which is
 * fast and never touches the judge model. This script then re-grades the rows
 * that string matching rejected, using the judge model — LongMemEval's own
 * metric is LLM-as-judge, so the number is not comparable without it.
 *
 * Splitting the two passes matters locally. The judge is deliberately a
 * different model from the one under test, and Ollama keeps one model resident
 * at a time: judging inside each instance swaps models twice per question, and
 * on a 500-question run that is hours of loading. Doing it in one pass at the
 * end pays the swap once.
 *
 *   node scripts/judge-run.mjs results/oracle.jsonl
 *   node scripts/judge-run.mjs results/oracle.jsonl --out results/oracle-judged.jsonl
 */

import { readFile, writeFile } from "node:fs/promises"

const args = { input: null, out: null, base: process.env.EVAL_BASE_URL ?? "http://localhost:3001" }
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === "--out") args.out = process.argv[++i]
  else if (arg === "--base") args.base = process.argv[++i]
  else if (!args.input) args.input = arg
  else {
    console.error(`Unknown argument: ${arg}`)
    process.exit(1)
  }
}
if (!args.input) {
  console.error("usage: node scripts/judge-run.mjs <results.jsonl> [--out judged.jsonl]")
  process.exit(1)
}
args.out ??= args.input.replace(/\.jsonl$/, "") + "-judged.jsonl"

const rows = (await readFile(args.input, "utf8"))
  .split("\n")
  .filter((line) => line.trim())
  .flatMap((line) => {
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })

// Only answerable questions with an answer the string matcher rejected are worth
// a judge call. An abstention instance is graded by whether it abstained, which
// no model needs to decide, and a row already marked correct cannot improve.
const pending = rows.filter(
  (row) => !row.isAbstention && !row.correct && row.systemAnswer && !row.error
)

console.log(`rows        ${rows.length}`)
console.log(`to judge    ${pending.length}`)
console.log(`output      ${args.out}\n`)

let flipped = 0
for (let i = 0; i < pending.length; i++) {
  const row = pending[i]
  try {
    const res = await fetch(`${args.base}/api/judge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: row.question,
        answer: row.systemAnswer,
        gold: row.goldAnswer,
      }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
    row.judged = true
    if (body.correct) {
      row.correct = true
      flipped++
    }
    process.stdout.write(
      `\r[${i + 1}/${pending.length}] ${flipped} upgraded to correct        `
    )
  } catch (error) {
    process.stdout.write(`\n${row.questionId} judge failed: ${error.message}\n`)
  }
}
process.stdout.write("\n")

await writeFile(args.out, rows.map((row) => JSON.stringify(row)).join("\n") + "\n")

const byType = {}
let correct = 0
for (const row of rows) {
  const bucket = (byType[row.questionType] ??= { total: 0, correct: 0 })
  bucket.total++
  if (row.correct) {
    bucket.correct++
    correct++
  }
}
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "n/a")
console.log("\n" + "=".repeat(64))
console.log(`Overall (judged)   ${correct}/${rows.length}  ${pct(correct, rows.length)}`)
console.log("-".repeat(64))
for (const [type, bucket] of Object.entries(byType).sort()) {
  console.log(`${type.padEnd(30)} ${bucket.correct}/${bucket.total}  ${pct(bucket.correct, bucket.total)}`)
}
console.log("=".repeat(64))
