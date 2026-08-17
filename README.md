# Track 3 — Memory and Context Retrieval

**Hack Hydra** · Aug 12-20, 2026 · Built on [HydraDB](https://github.com/hydra-db/hydradb)

## Problem statement

Make your own mem0, and ace the benchmarks.

Build an agent memory layer for cross session continuity. It has to process chat histories spanning 30 to 40 sessions and 115,000 tokens per question.

The system has to synthesize facts across sessions, keep chronological order and track information that was later overwritten. Long context models drop 30 to 60% in accuracy here, and they mostly fail at abstention: knowing when the answer simply is not in the history and saying so instead of inventing one.

## Datasets

- [LongMemEval](https://github.com/xiaowu0162/LongMemEval)
- LongMemEval V2
- BEAM

## What a strong submission needs

- A functional product or demo
- Real ingestion and retrieval workflows
- A clear use case
- A thoughtful technical implementation
- HydraDB doing real work (graph-native data model, not just sitting in the README)

## Rules recap

- Work starts on or after **August 12, 2026** — fresh repo, no prior commits.
- HydraDB must be genuinely used — be ready to explain what the project would lose without it.
- Submission requires: public GitHub repo (with OSS license, README, setup instructions, HydraDB usage explanation, third-party attribution), a demo video (≤ 3 min), and the submission form.
- Deadline: **August 20, 2026, 11:59 PM PT**.

Full event details: see `../hack-hydra.md`.

## Stack

Next.js (App Router, TypeScript, Tailwind) + HydraDB.

---

## Getting Started

First, run the development server:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `src/app/page.tsx`. The page auto-updates as you edit the file.
