# Completion — track3 (agent memory)

Tracks what's actually built vs. what plan.md describes. Updated as work lands.

**Status: the graph layer is complete and verified end-to-end against a live HydraDB
graph-node, and the LongMemEval harness is verified against both real official splits.**
The benchmark run itself has not been executed — it needs an `ANTHROPIC_API_KEY` and API
budget, and that is now the single remaining blocker for this track.

## Verified live against a running graph-node

All of the following was executed, not inferred from documentation:

- **Knowledge update**: session 0 asserts `prefers_theme = dark mode`; session 5 asserts
  `light mode`. The write reported `factsSuperseded: 1`, and the graph shows the old fact
  closed at exactly the new fact's `valid_from` (`validTo 1685282700000` ==
  `validFrom 1685282700000`) with both retained. **48ms** for the whole supersede sequence.
- **Current truth**: returns `light mode` only, in **2–3ms**, via the `current` path.
- **Full history**: returns both versions oldest-first, the old one marked superseded.
- **Abstention**: an unstated predicate returns 0 rows, `abstained: true`,
  `reason: "Not found in memory"` — and the answer layer is never called.
- **Provenance**: each answer carries the exact source turn, e.g. *"Actually I went back to
  light mode, dark strained my eyes."* (session 5, role user) — which required storing
  `Message.content` on the vertex.
- **Multi-hop**: `algo.SSpaths` from entity `editor` returned 10 paths, walking
  `Entity → Fact → SUPERSEDES → Fact → Message → Session` across sessions.
- **Eval harness against the real dataset**: both official splits downloaded from
  HuggingFace (`xiaowu0162/longmemeval`, oracle 15MB / S 266MB, 500 instances each) and
  parsed by the harness — **0 unparseable timestamps across all 500 instances**, correct
  type counts (temporal-reasoning 133, multi-session 133, knowledge-update 78,
  single-session-user 70, single-session-assistant 56, single-session-preference 30) and
  30 abstention instances detected. Filtering by type / abstention / id / offset verified
  on real rows. Per-instance errors are captured rather than crashing a long run, and an
  errored abstention instance is *not* scored as a correct abstention.
- **Graph layer at real LongMemEval volume** (`scripts/scale-check.mjs`): the worst-case S
  instance — 66 sessions, 564 turns, ~121K tokens, the exact size the track brief
  describes — ingests in **1.4–1.6s at ~400 messages/sec**. Extrapolated, the full
  25,112-session run is roughly **9 minutes of graph writes**. The graph is not the
  bottleneck; the 25,112 extraction calls are.
- `npx tsc --noEmit` clean · `npm run build` clean.

## Done

- [x] Landing page (navbar, hero, marquee, bento grid, feature cards, how-it-works,
      benchmarks, pricing, CTA, footer) — branded "track3", blue accent
- [x] **Live memory console** wired to the real API — ingest 3 sessions where one
      contradicts another, then probe current truth / full history / other session /
      never-stated, with the source turn quoted and superseded facts visibly greyed
- [x] `src/lib/hydradb.ts` — HTTP client with the **verified** wire contract: `parameters`
      (not `params`), positional type-tagged row decoding, path decoding, `HydraSession`
      bookmark threading, structured error surfacing
- [x] `src/lib/graphwrite.ts` — the two `UNWIND` batch forms HydraDB actually executes
- [x] `src/lib/memory.ts` — session/message/fact/entity writes, supersede semantics,
      current-truth and history reads, entity fan-out, provenance lookup, multi-hop, counts
- [x] `src/lib/extract.ts` — Claude fact extraction with per-turn source indices, query
      planning, and answer synthesis with enforced abstention
- [x] `src/lib/longmemeval.ts` — dataset schema, filtering (type / abstention / id /
      offset), string + LLM-judge grading, summary stats including session-level recall
- [x] `src/lib/evalrunner.ts` — drives one instance end-to-end, namespaced per
      `question_id` so 500 haystacks share one graph without bleeding
- [x] `scripts/run-eval.mjs` — full-run CLI, streams JSONL, resumes after an interruption
- [x] API routes: `health`, `stats`, `ingest`, `query`, `eval`
- [x] `LICENSE` (MIT), README with setup + HydraDB usage + LongMemEval instructions +
      third-party attribution
- [x] `HYDRADB-NOTES.md` — the wire contract as verified, including constraints the
      published docs don't state
- [x] plan.md reconciled, with a divergences section rather than silent edits
- [x] Landing-page copy corrected. It previously advertised a **different product**:
      "LongMemEval 90.79%", a 5-channel semantic/emotional retrieval fusion via RRF, and
      Thompson Sampling adaptive weights — none of which exist, and the semantic channel
      directly contradicted plan.md's deliberate no-vectors thesis. Replaced with the real
      differentiators and measured numbers; the benchmark row is left blank.

### Bugs found and fixed along the way

- **Fact identity collision.** Keying a fact on `(subject, predicate, valid_from)` meant two
  revisions inside one session produced the same vertex id: the second write overwrote the
  first in place, closed it against its own `valid_from` (making it invisible to
  current-truth reads), and created a `SUPERSEDES` self-loop. Identity now includes the
  object.
- **Messages stored no content.** The `ASSERTS` provenance edge existed but pointed at a
  vertex with no text, so no answer could quote its source.
- **Session-wide timestamps.** Facts were stamped with `Date.now()` per session, flattening
  every turn onto one instant. Now stamped from the asserting turn, which is what
  temporal-reasoning questions order by.

## Not done yet

- [ ] **LongMemEval has not been run.** This is the top priority and the only remaining
      blocker. Everything else is ready: both splits are downloaded to `data/`, the harness
      parses them, and the graph is measured fast enough. What it needs is an
      `ANTHROPIC_API_KEY` in `.env.local` and API budget — the full S split is 25,112
      extraction calls plus 500 planning, 500 synthesis and up to 500 judge calls.
      Recommended order: `--limit 5` to sanity-check the loop, then
      `--types knowledge-update` (78 instances, the split this data model should win
      hardest), then the full run.
- [ ] **Supersede is not atomic.** A read followed by three durable writes. Concurrent
      writers on the same `(subject, predicate)` could interleave, and HydraDB exposes no
      guarded-merge primitive to prevent it. The eval runner writes sessions sequentially
      because of this, parallelising only extraction.
- [ ] **Entity resolution is naive** — a lowercased-name `MERGE`. "Sam" vs "@soham" remain
      separate entities, and the track brief calls this out as a hard part.
- [ ] **Query planning is single-shot.** One predicate guess with an entity fallback. A
      multi-session question needing two different predicates will under-retrieve.
- [ ] **BEAM and LongMemEval-V2 are not wired** — only the base LongMemEval schema is read.
- [ ] **No graph visualisation** in the console; multi-hop paths are returned by the API
      (`GET /api/query?entity=`) but not drawn.
- [ ] Demo video not recorded.

## Reproduce the verification

```bash
# graph-node (RUST_MIN_STACK is mandatory — see README)
docker run --rm --name hydradb --user "$(id -u):$(id -g)" \
  -p 7687:7687 -p 8443:8443 -p 9090:9090 -v "$PWD/.hydradb:/data" \
  -e CLOUD_PROVIDER=local -e LOCAL_PATH=/data/store \
  -e GRAPH_NAMESPACE=default -e GRAPH_ID=default \
  -e GRAPH_CELL_ID=cell-0 -e GRAPH_CELLS=cell-0 -e GRAPH_NODE_ID=node-0 \
  -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
  -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_DATA_CACHE_DIR=/data/cache -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
  -e GRAPH_ALLOW_PLAINTEXT=true -e RUST_MIN_STACK=33554432 \
  ghcr.io/hydra-db/hydradb:latest

cp .env.example .env.local && npm install && npm run dev

# The knowledge-update scenario, without needing an API key (facts supplied directly)
curl -X POST localhost:3000/api/ingest -H 'content-type: application/json' -d '{
  "userExternalId":"u1","sessionIndex":0,"startedAt":1684549260000,
  "messages":[{"role":"user","content":"I switched to dark mode.","ts":1684549260000}],
  "facts":[{"subject":"user","predicate":"prefers_theme","object":"dark mode",
            "entities":["editor"],"sourceMessageIndex":0}]}'

curl -X POST localhost:3000/api/ingest -H 'content-type: application/json' -d '{
  "userExternalId":"u1","sessionIndex":5,"startedAt":1685282700000,
  "messages":[{"role":"user","content":"Actually I went back to light mode.","ts":1685282700000}],
  "facts":[{"subject":"user","predicate":"prefers_theme","object":"light mode",
            "entities":["editor"],"sourceMessageIndex":0}]}'
# -> factsSuperseded: 1

curl -X POST localhost:3000/api/query -H 'content-type: application/json' \
  -d '{"userExternalId":"u1","subject":"user","predicate":"prefers_theme","retrieveOnly":true}'
# -> light mode, CURRENT, with the session-5 turn as provenance

curl -X POST localhost:3000/api/query -H 'content-type: application/json' \
  -d '{"userExternalId":"u1","subject":"user","predicate":"favourite_airline","retrieveOnly":true}'
# -> abstained: true
```
