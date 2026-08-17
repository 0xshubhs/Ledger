# Plan — Track 3: Memory and Context Retrieval

Graph-native agent memory layer, built on HydraDB, benchmarked against LongMemEval / LongMemEval-V2 / BEAM.

## Why HydraDB fits this problem

mem0-style systems retrieve by vector similarity, which is a weak proxy for "is this fact still true" and "how do these facts relate." Our bet: model memory as a **fact graph with time and provenance edges**, so that:

- **Knowledge updates** are a graph write (a new fact node `SUPERSEDES` the old one), not a re-embedding.
- **Multi-hop reasoning** ("what did the user decide after X happened") is a bounded traversal, not a rerank over chunks.
- **Abstention** falls out for free: if a Cypher `MATCH` returns zero rows, the honest answer is "not in memory" — no nearest-neighbor forces a plausible-looking but wrong chunk into context.

## HydraDB surface we use

| HydraDB feature | How we use it |
|---|---|
| `graph-node` (Docker: `ghcr.io/hydra-db/hydradb`) | Single local dev node — Bolt `:7687`, HTTPS query API `:8443`, admin/metrics `:9090` |
| HTTPS JSON query API (`POST /v1/graphs/{graph}/query`) | **The client actually used.** `neo4j-driver` over Bolt was the original plan; HTTP won because Next.js route handlers are short-lived. Wire contract in `HYDRADB-NOTES.md`. |
| OpenCypher subset (`CREATE`, `MERGE`, `MATCH`, `UNWIND` batch writes) | Ingest sessions/messages/facts, query current + historical state |
| `UNWIND` batch `MERGE` + `SET`, then `MATCH ... SET` | Implements "knowledge update" semantics: read current, write the new fact, close the old one, link `SUPERSEDES`. Note there is **no** guarded-merge primitive — a standalone `MERGE (n {id})` is rejected outright, and `MERGE ... SET` in one statement is too, so every vertex write goes through the `UNWIND` form. |
| `algo.SSpaths` native path procedure | Multi-hop reasoning across sessions, from a named entity across `ABOUT`/`SUPERSEDES`/`ASSERTS`/`CONTAINS`. `relTypes` must be a literal array — as a parameter it is rejected as a composite. |
| `causal` vs `strong` read consistency | `causal` (default) for normal Q&A latency; `strong` immediately after ingesting a new session, so the answer step is guaranteed to see what was just written |
| Bookmarks (durable sequence) | Passed from the ingest write to the following read so multi-step agent turns are read-your-writes correct |

### Graph data model

```
(:User {id})
(:Session {id, index, startedAt, endedAt})
(:Message {id, role, content, ts, session_index, message_index})
(:Entity {id, name, normalized})         // person, place, project, preference, etc.
(:Fact {id, subject, predicate, object, valid_from, valid_to, session_index})

(:User)-[:HAS_SESSION]->(:Session)
(:Session)-[:CONTAINS]->(:Message)
(:Message)-[:MENTIONS]->(:Entity)
(:Message)-[:ASSERTS]->(:Fact)
(:Fact)-[:ABOUT]->(:Entity)
(:Fact)-[:SUPERSEDES]->(:Fact)            // overwritten knowledge, kept not deleted
```

Facts are never deleted on update — the old fact stays, linked via `SUPERSEDES`, so we can answer "what did you believe before" as well as "what's true now." This is the concrete use of HydraDB's append-friendly, snapshot-consistent model instead of a vector store's overwrite-or-duplicate behavior.

### Retrieval query shapes

- **Current truth**: `MATCH (f:Fact) WHERE ... AND f.valid_to = 0 RETURN ... ORDER BY validFrom DESC LIMIT 1`. Note `valid_to = 0` rather than `IS NULL`: HydraDB's `WHERE` rejects `IS NULL` outright, so "still true" is a sentinel value.
- **Full history for a fact**: same pattern without the `validTo` filter, `ORDER BY f.validFrom`
- **Cross-session multi-hop**: `CALL algo.SSpaths({sourceNode: ..., relTypes: ['ABOUT','MENTIONS'], maxLen: 4}) YIELD path RETURN path`
- **Abstention check**: if the above return 0 rows, the answer layer must emit "not found in memory," not fall through to the LLM's own guess

## Non-HydraDB repos and APIs

| Component | Source | Purpose |
|---|---|---|
| **LongMemEval** | [xiaowu0162/LongMemEval](https://github.com/xiaowu0162/longmemeval) (ICLR 2025) | Primary eval set — 500 questions, ~48 sessions/question, ~115K tokens; tests info extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention |
| **LongMemEval-V2** | [xiaowu0162/LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2) | Harder variant — 451 questions, "experienced colleague" style memory tasks (static/dynamic state, workflow knowledge, gotchas) |
| **BEAM** | [mohammadtavakoli78/BEAM](https://github.com/mohammadtavakoli78/BEAM) (ICLR 2026) | Multi-scale stress test (128K → 10M tokens), 10 memory abilities, used to show the system doesn't fall over at extreme session counts |
| **Anthropic Claude API** | `@anthropic-ai/sdk` | (1) Fact/entity extraction from raw chat turns → graph writes; (2) final answer synthesis over the retrieved subgraph; (3) contradiction detection between a new statement and an existing `Fact` node before deciding whether to `SUPERSEDES` |
| **OpenAI API** (optional, comparison baseline) | `openai` npm package | Reproduce the long-context-baseline numbers the papers report, so our benchmark table has an honest "graph vs. long-context-stuffing" comparison |

No embedding/vector API is used deliberately — that's the point of the submission (graph-native retrieval vs. mem0's vector approach).

## App architecture (Next.js)

```
src/app/api/ingest/route.ts     # accepts a session transcript, calls Claude for extraction, UNWIND-batches into HydraDB
src/app/api/query/route.ts      # accepts a question, plans Cypher (fact lookup / path query), executes, synthesizes answer
src/app/api/eval/route.ts       # runs a LongMemEval split end-to-end, scores against gold answers
src/lib/longmemeval.ts          # dataset types, filtering, grading (string match + Claude judge), summary stats
src/lib/evalrunner.ts           # drives one instance: ingest haystack -> retrieve -> grade
scripts/run-eval.mjs            # full-run CLI, streams JSONL, resumes after an interruption
src/lib/graphwrite.ts           # the two UNWIND batch forms HydraDB actually executes
src/lib/hydradb.ts              # Bolt driver client + HTTP fallback, causal/strong helpers, bookmark passing
src/lib/extract.ts              # Claude prompt(s) for entity/fact extraction + contradiction detection
src/components/memory-console.tsx # demo UI: ingest 3 sessions where one contradicts another, probe current truth / history / abstention, see the source turn quoted
```

## 9-day build sequence

1. **Day 1–2**: Stand up `graph-node` locally (Docker), confirm Bolt round-trip from Next.js via `neo4j-driver`; define schema; write ingest pipeline for one LongMemEval sample.
2. **Day 3–4**: Fact extraction + contradiction/supersede logic via Claude; batch `UNWIND` ingestion for full sessions.
3. **Day 5–6**: Retrieval layer — current-truth queries, history queries, `algo.SSpaths` multi-hop, abstention rule; wire up answer synthesis.
4. **Day 7**: Run LongMemEval-S end-to-end, score against gold labels, tune extraction/retrieval prompts.
5. **Day 8**: Add BEAM at larger token scale as a stress test; polish demo UI with the "why this answer" graph explanation panel.
6. **Day 9**: Record demo video, finalize README (HydraDB usage explanation, benchmark numbers, attribution), submit.

## Divergences from this plan, and why

Recorded rather than quietly edited, since the plan is part of the submission.

1. **HTTP instead of Bolt.** `neo4j-driver` is not a dependency; see the table above.
2. **No guarded merge exists.** The plan assumed a `MERGE` + `SET` with a version check
   would implement supersede semantics atomically. HydraDB rejects both a standalone vertex
   `MERGE` and a single-statement `MERGE ... SET`, so a supersede is a read followed by
   three writes. Each is individually durable, and bookmarks keep the sequence ordered, but
   it is not one atomic operation. A concurrent writer on the same
   `(subject, predicate)` could interleave; the eval runner therefore writes sessions
   sequentially rather than concurrently, and only parallelises extraction.
3. **`valid_to = 0` sentinel instead of `IS NULL`**, because `IS NULL` is not supported.
4. **`algo.SPpaths` is unused here.** Entity-to-entity shortest path was in the plan;
   `algo.SSpaths` from one entity covers the multi-hop cases the questions actually ask.
5. **Fact identity includes the object.** Keying on `(subject, predicate, valid_from)` alone
   collided when one session revised the same predicate twice, corrupting the very history
   the model exists to preserve.
6. **Entity resolution is still naive** — a lowercased-name `MERGE`. "Sam" and "@soham"
   remain separate entities. The track brief calls this out as a hard part and it is not
   solved.
7. **LongMemEval has not been run.** The harness is complete and tested against a synthetic
   fixture in the real dataset schema, but no accuracy number exists yet. This is the
   largest outstanding gap, and the landing page's benchmark row is left blank because of it.
8. **BEAM and LongMemEval-V2 are not wired.** Only the base LongMemEval schema is supported.
