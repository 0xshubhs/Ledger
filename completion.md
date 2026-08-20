# Completion — Ledger (agent memory)

Tracks what's actually built vs. what plan.md describes. Updated as work lands.

**Status: the graph layer is complete and verified end-to-end against a live HydraDB
graph-node, the LLM runs locally with no API key, and LongMemEval is now being scored
rather than merely parsed.** A partial run exists — see *Benchmark* below — and the full
100-instance stratified sample resumes with one command.

## Benchmark

**LongMemEval oracle split · 116 instances · 56 correct (48.3%)** — everything local:
`qwen3.5-16k:4b` answering, `qwen2.5:7b` judging. A different model grades than the one
under test, so the system is not marking its own homework. Graded by normalised string
match first, LLM judge only where that was inconclusive, which is LongMemEval's own metric.

| question type | correct | | note |
|---|---|---|---|
| single-session-user | 11/14 | **78.6%** | |
| knowledge-update | 24/32 | **75.0%** | the type this data model exists for |
| temporal-reasoning | 6/16 | 37.5% | |
| single-session-preference | 2/6 | 33.3% | was 0/6 before the fix below |
| multi-session | 10/34 | 29.4% | weakest answerable type; needs facts from several sessions at once |
| single-session-assistant | 3/14 | 21.4% | was 1/14 before the fix below |
| **overall** | **56/116** | **48.3%** | was 52/116 (44.8%) |

Scope, stated rather than rounded off: 116 of a 100-instance stratified sample plus 16
earlier rows, on the *oracle* split (evidence sessions only, easier than S), answered by a
4-billion-parameter model on a laptop. The published figures other projects report — Zep
71.2%, full-context GPT-4 60.2%, mem0 29.07% — are overall numbers on the harder S split
with frontier models. These are not the same measurement and should not be read as a
ranking.

**What the two zeros were.** Both are the system failing to store or use evidence it had,
not a model that could not reason:

- `single-session-assistant` asks what the *assistant* said. The extraction prompt said
  "skip anything the assistant asserted about itself" — intended to drop "I am an AI",
  but it also dropped "I recommend Roscioli". Two of three sampled misses retrieved
  **zero facts**: the answer was never written down. The prompt now keeps what the
  assistant told the user, under an `assistant` subject.
- `single-session-preference` is worse and more interesting: every sampled miss retrieved
  facts *and* scored session recall True. The evidence was in hand and the answer layer
  abstained. These questions are not lookups — "recommend a show for tonight" is asking
  the memory to shape a recommendation, and gold is "the user would prefer stand-up
  comedy". The answer prompt now says so.

Both were fixed and the same 20 instances re-measured by id (`run-eval.mjs --ids`), so this
is a like-for-like comparison rather than a fresh sample:

| | before | after |
|---|---|---|
| single-session-assistant | 1/14 (7.1%) | **3/14 (21.4%)** |
| single-session-preference | 0/6 (0%) | **2/6 (33.3%)** |
| the two families together | 1/20 (5%) | **5/20 (25%)** |
| overall | 52/116 (44.8%) | **56/116 (48.3%)** |

Both families are still weak — a 4B model asked what it recommended three sessions ago is
working at the edge of what it can do — but they are no longer zero for a structural
reason, which is the difference between a limitation and a bug. `results/fix-check.jsonl`
holds the re-run and `results/oracle-sample-final.jsonl` the merged set.

**What the misses look like elsewhere.** On the 16 instances inspected by hand, session
recall was 16/16 — every answer drew on a session the gold labels call evidence. The
failures were the answer layer choosing the wrong fact out of nine retrieved, which is a
model-capability ceiling at 4B rather than a retrieval failure.

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
- **Local inference on a 6GB RTX 4050** via Ollama (`qwen3.5-16k:4b`, a 16K-context
  variant of qwen3.5:4b), fully GPU-resident at 4554/6141 MiB. Extraction measured on
  real dataset sessions with `scripts/bench-llm.mjs`:

  | config | mean/session | facts (8 sessions) | empty | oracle run |
  |---|---|---|---|---|
  | thinking on, 4K ctx | 30.7s | **0** | 8/8 | 8.1 h |
  | `reasoning_effort=none`, 4K ctx | 3.8s | 11 | 4/8 | 60 min |
  | + 16K context | 6.4s | 16 | 4/8 | 1.7 h |
  | + prompt/parser fixes | 6.2s | **24** | 2/8 | **1.6 h** |

  The full S split projects to ~43h, so the oracle split is the realistic local target.
- **Local inference on an Apple M3** (16GB, `qwen3.5-16k:4b` through Ollama), measured with
  `scripts/bench-llm.mjs` on real dataset sessions: **30.4s mean per session, 6.3 facts per
  session, 1 of 8 sessions empty**. Slower per call than the 4050 numbers above and better
  per call — the prompt work moved after those measurements. Ollama serves this model with
  a single slot (`-np 1`), so concurrent extraction requests queue rather than overlap.
- **A graph-node per project.** Vertex writes get slower as the *whole* graph grows, not
  just this project's slice: the only executable vertex form is an unlabeled
  `MERGE (n {id})` with the label applied by a following `SET`, so there is no label index
  to narrow it. The same two-message ingest measured **93ms on an empty node** and
  **6,258ms** on one also holding ~1.5M vertices from the other track. The benchmark run
  therefore has its own node.
- `npx tsc --noEmit` clean · `npm run lint` clean.

## Done

- [x] Landing page (navbar, hero, marquee, bento grid, feature cards, how-it-works,
      benchmarks, pricing, CTA, footer) — branded "Ledger", blue accent
- [x] **Live memory console** wired to the real API — ingest 3 sessions where one
      contradicts another, then probe current truth / full history / other session /
      never-stated, with the source turn quoted and superseded facts visibly greyed
- [x] `src/lib/hydradb.ts` — HTTP client with the **verified** wire contract: `parameters`
      (not `params`), positional type-tagged row decoding, path decoding, `HydraSession`
      bookmark threading, structured error surfacing
- [x] `src/lib/graphwrite.ts` — the two `UNWIND` batch forms HydraDB actually executes
- [x] `src/lib/memory.ts` — session/message/fact/entity writes, supersede semantics,
      current-truth and history reads, entity fan-out, provenance lookup, multi-hop, counts
- [x] `src/lib/llm.ts` — pluggable LLM backend: Claude, or any OpenAI-compatible server
      (Ollama at `:11434/v1`, llama.cpp/localAI at `:8080/v1`). Auto-detects: local unless
      `ANTHROPIC_API_KEY` is set. Defaults `reasoning_effort` to `none`, strips reasoning
      traces, and raises a named error when a model spends its whole budget thinking
- [x] `src/lib/extract.ts` — fact extraction with per-turn source indices, query planning,
      and answer synthesis with enforced abstention
- [x] `scripts/bench-llm.mjs` — measures seconds-per-session on real dataset input and
      projects wall-clock for both splits
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

### Bugs found by running the benchmark

- **Retrieval raced its tiers and returned the first that matched.** An entity lookup that
  hit returned two to five facts and short-circuited the working set, so
  "which did I attend first, the workshop or the webinar" was answered from one of the two
  events. Every early-returned entity hit on temporal-reasoning abstained. The tiers now
  union.
- **The answer layer could not see time.** Facts were rendered with a session index and
  nothing else, which makes ordering questions unanswerable in principle — and 133 of the
  500 questions are temporal. They now carry the `valid_from` date, stamped from the
  asserting turn.
- **A triple loses the answer.** LongMemEval grades the detail ("GPS system not functioning
  correctly"), which survives extraction as `car_issue: GPS` at best. Retrieved facts are
  now rendered with the sentence that asserted them, one hop away across `ASSERTS`.
- **Updates were not updates.** Supersede is keyed on `(subject, predicate)`, and nothing
  made the extractor reuse a relation name across sessions — it wrote `ran_charity_5K_in`
  in one and `has_personal_best_time` in the next, so both survived as current truth and
  the answer layer picked whichever read closest to the question. Extraction is now primed
  with the relation names already stored for that user. Verified: a session revising a time
  now reports `factsSuperseded: 1` where it previously wrote an unrelated second fact.
- **A slow instance killed the run.** `fetch` gives up on response headers after 300s, and
  a loaded machine can push an instance past that; the runner logged "fetch failed" and
  dropped the instance. It now retries once.

### Bugs found by running a local model

- **Hybrid reasoning models silently produce nothing.** qwen3.5:4b spent all 800 completion
  tokens on chain-of-thought and returned empty `content` — and because Ollama puts that
  text in a separate `reasoning` field, the response still looked well-formed. 8/8 sessions
  extracted zero facts while burning 30s each. `reasoning_effort: "none"` fixes it (0.9s,
  correct JSON). Note `think: false` and `chat_template_kwargs.enable_thinking` are both
  silently *ignored* on Ollama's `/v1` endpoint. The client now raises an explicit error on
  the empty-content-with-reasoning case rather than returning "" as if no facts existed.
- **The prompt taught the model to break its own output format.** Transcripts were numbered
  `[0] user: ...`, and the model echoed that into its answer as `[0] {"subject":...}` —
  one object per line instead of a JSON array. A first-bracket-to-last-bracket slice made
  that unparseable, so those sessions silently yielded nothing. Markers are now `#N`, and
  the parser accepts arrays, fenced arrays, prose-wrapped arrays, truncated arrays, and
  line-delimited objects with any leading marker.
- **The judge scored wrong answers as correct.** `"INCORRECT".includes("CORRECT")` is true,
  so any verdict with extra words passed. Only surfaced with chattier local models.
- **The judge was capped at 16 output tokens**, which truncates a local model mid-reasoning
  and loses the verdict entirely.

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

- [ ] **The benchmark run is 16 of 100 instances.** It is running and resumable rather than
      blocked; what is missing is wall-clock, roughly 80s per instance on this hardware. The
      remaining 84 cover multi-session, temporal-reasoning, the three single-session types
      and the abstention set — and abstention in particular is untested by the 16 scored so
      far, which is the claim this design leans on hardest.
- [ ] **The answer layer picks the wrong row when the facts are close together.** All three
      benchmark misses are this, not retrieval: session recall was 16/16 and the correct
      fact was in the retrieved set every time. A larger model would likely fix it, which
      makes it a model-capability ceiling rather than a design flaw — but the prompt could
      also rank facts by relevance rather than handing over nine in date order.
- [ ] **`wantsHistory` is decided by a single planner call and gets it wrong.** One miss was
      a question explicitly about superseded truth, which the graph holds and the answer
      layer never saw, because the plan asked for current facts.
- [ ] **A 4B model is a real quality ceiling.** `qwen3.5:9b` (6.6GB) would spill past 6GB
      VRAM but is worth testing on a small slice; the 27B models named as candidates need
      ~17GB and would run at CPU-bound speeds, which 25,112 calls cannot absorb.
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
