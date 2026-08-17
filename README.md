# track3 — Agent Memory on a Temporal Fact Graph

**Hack Hydra** · Track 3, Memory and Context Retrieval · Aug 12–20, 2026 · Built on
[HydraDB](https://github.com/hydra-db/hydradb)

An agent memory layer for cross-session continuity, built as a **fact graph with time and
provenance edges** rather than a vector store. No embedding model is used anywhere in this
project — that is the submission's central claim, not an omission.

## The bet

mem0-style memory retrieves by vector similarity, which is a weak proxy for two questions
that matter most over 30–40 sessions:

- **Is this fact still true?** A revision and the thing it revises are *similar*, so
  similarity cannot separate them. Here a revision closes the old fact (`valid_to`) and
  links `SUPERSEDES` to it. Current truth and full history become the same query with a
  different time filter, and nothing is ever overwritten or deleted.
- **Is the answer in memory at all?** Nearest-neighbour search always returns something, so
  "not in memory" is unreachable — which is why long-context models mostly fail abstention.
  Here retrieval is a Cypher `MATCH`. Zero rows ends the request, and the answer layer is
  additionally required to emit a sentinel rather than guess.

Every answer also carries an `ASSERTS` edge back to the exact conversation turn that stated
the fact, so it can quote its own source.

## Measured

On a local graph-node, verified live:

| | |
|---|---|
| Current-truth fact lookup | **2–3ms** |
| Full-history lookup (2 versions) | **2ms** |
| Knowledge-update write (close old + link `SUPERSEDES`) | **48ms** |
| Abstention on an unstated predicate | 0 rows, no answer produced |
| Embedding / vector API calls | **0** |

Graph layer at real benchmark volume (`scripts/scale-check.mjs`): the worst-case
LongMemEval-S haystack — 66 sessions, 564 turns, ~121K tokens — ingests in **1.4–1.6s at
~400 messages/sec**. The full 25,112-session run is ~9 minutes of graph writes, so the
graph is not the bottleneck; the 25,112 extraction calls are.

**LongMemEval accuracy: not yet measured.** The harness is built and verified against both
official splits (`src/lib/longmemeval.ts`, `src/lib/evalrunner.ts`, `scripts/run-eval.mjs`)
— 500 instances parsed, zero unparseable timestamps, all six question types and the 30
abstention instances detected — but the scored run needs an API key and budget and has not
been executed. The landing page's benchmark row is deliberately blank rather than filled
with a number we did not produce.

## Graph model

```
(:User {id, external_id})
(:Session {id, session_index, started_at, ended_at})
(:Message {id, role, content, ts, session_index, message_index})
(:Entity {id, name, normalized})
(:Fact {id, subject, predicate, object, valid_from, valid_to, session_index})

(:User)-[:HAS_SESSION]->(:Session)
(:Session)-[:CONTAINS]->(:Message)
(:Message)-[:ASSERTS]->(:Fact)          // provenance: which turn said it
(:Fact)-[:ABOUT]->(:Entity)
(:Fact)-[:SUPERSEDES]->(:Fact)          // overwritten knowledge, kept not deleted
```

`valid_to = 0` means "still true". HydraDB's `WHERE` rejects `IS NULL` outright, so an
open-ended interval is a sentinel rather than an absent property.

### Retrieval shapes

- **Current truth** — `MATCH (f:Fact) WHERE ... AND f.valid_to = 0 ... ORDER BY validFrom DESC LIMIT 1`
- **Full history** — same pattern without the `valid_to` filter, ordered by `valid_from`
- **Entity fan-out** — `MATCH (f:Fact)-[:ABOUT]->(e:Entity) WHERE e.id = $id AND f.valid_to = 0`
- **Multi-hop** — `algo.SSpaths` from an entity across `ABOUT`, `SUPERSEDES`, `ASSERTS`,
  `CONTAINS`; verified walking `Entity → Fact → SUPERSEDES → Fact → Message → Session`
- **Abstention** — any of the above returning zero rows stops the request

### What this loses without HydraDB

- **Guarded temporal writes.** A supersede is "close the old row, create the new one, link
  them" — three statements, each durable on return. On a vector store this is a delete plus
  an insert, and the prior belief is gone.
- **`algo.SSpaths`** gives bounded multi-hop traversal as one call. Client-side it becomes a
  round trip per frontier node per hop.
- **Bookmarks** let an ingest hand its durable sequence to the read that follows, so an
  agent's next turn is read-your-writes correct without `strong` consistency everywhere.

## Setup

Requires Node 20+ and Docker. The LLM backend is pluggable and **runs locally with no API
key** by default — see "Local inference" below. The demo console needs no LLM at all; it
supplies facts directly so the graph layer can be exercised on its own.

```bash
# 1. Start a HydraDB graph-node
mkdir -p .hydradb/store .hydradb/cache
printf '%s\n' 'local-development-token-32-bytes' > .hydradb/auth-token
docker run -d --name hydradb --user "$(id -u):$(id -g)" \
  -p 7687:7687 -p 8443:8443 -p 9090:9090 -v "$PWD/.hydradb:/data" \
  -e CLOUD_PROVIDER=memory \
  -e GRAPH_NAMESPACE=default -e GRAPH_ID=default \
  -e GRAPH_CELL_ID=cell-0 -e GRAPH_CELLS=cell-0 -e GRAPH_NODE_ID=node-0 \
  -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
  -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_DATA_CACHE_DIR=/data/cache \
  -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
  -e GRAPH_ALLOW_PLAINTEXT=true -e RUST_MIN_STACK=33554432 \
  ghcr.io/hydra-db/hydradb:latest

# RUST_MIN_STACK is mandatory. Without it the node serves /readyz and then
# aborts with a stack overflow on the first query.
```

> **Use `CLOUD_PROVIDER=memory`, not `local`.** The local-filesystem object
> store does not implement conditional writes — after enough writes SlateDB
> needs a `PutMode::Update` on its manifest and `LocalFileSystem` rejects it,
> surfacing as `HTTP 500 internal query execution error` on an arbitrary
> statement with the real cause only in the node's own log:
> `Operation put_opts with mode PutMode::Update not yet implemented by
> LocalFileSystem`. Small demos survive it; any sustained ingest does not.
> `memory` has no such limit but is not durable across a container restart —
> for a long run, keep the container up, or point at S3/MinIO instead.

```bash
# 2. Start a local model (no API key needed)
ollama pull qwen3.5:4b
printf 'FROM qwen3.5:4b\nPARAMETER num_ctx 16384\n' > /tmp/M
ollama create qwen3.5-16k:4b -f /tmp/M     # 4K default truncates long sessions
ollama serve

# 3. In another shell
cp .env.example .env.local     # already points at Ollama; no key required
npm install
npm run dev
```

### Local inference

`src/lib/llm.ts` speaks two protocols, chosen by `LLM_PROVIDER` or inferred (Claude if
`ANTHROPIC_API_KEY` is set, otherwise local):

```bash
LLM_BASE_URL=http://localhost:11434/v1   # Ollama
LLM_BASE_URL=http://localhost:8080/v1    # llama.cpp / llama-server, incl. localAI
```

Two settings matter more than the model choice, both measured on a 6GB RTX 4050:

| config | mean/session | facts from 8 sessions |
|---|---|---|
| defaults (thinking on, 4K ctx) | 30.7s | **0** |
| `reasoning_effort=none` | 3.8s | 11 |
| + 16K context | 6.4s | 16 |
| + prompt & parser fixes | 6.2s | **24** |

A hybrid reasoning model spends its entire token budget deliberating and returns empty
content, so `LLM_REASONING_EFFORT` defaults to `none`. `think: false` and
`chat_template_kwargs.enable_thinking` are silently ignored on Ollama's `/v1` endpoint —
`reasoning_effort` is the one that works. Measure your own hardware with:

```bash
node scripts/bench-llm.mjs data/longmemeval_oracle.json
```

At 6.2s/session the oracle split (948 sessions) is ~1.6h and the S split (25,112) is ~43h,
so oracle is the realistic local target.

Open <http://localhost:3000>, scroll to **Live memory console**, then click
`ingest 3 sessions` and run the four probes. The third session contradicts the first; the
`full history` probe shows both facts with the old one closed, and `never stated` abstains.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | graph-node reachability (`/readyz`) |
| `GET /api/stats` | Session / message / fact / entity counts |
| `POST /api/ingest` | Transcript → Claude extraction → graph write (pass `facts` to skip extraction) |
| `POST /api/query` | Question → plan → retrieve → synthesize, with enforced abstention |
| `GET /api/query?entity=` | `algo.SSpaths` multi-hop around one entity |
| `POST /api/eval` | Run a LongMemEval split and score it |

```bash
curl -X POST localhost:3000/api/ingest -H 'content-type: application/json' -d '{
  "userExternalId":"u1","sessionIndex":0,
  "messages":[{"role":"user","content":"I prefer dark mode.","ts":1700000000000}]}'

curl -X POST localhost:3000/api/query -H 'content-type: application/json' -d '{
  "userExternalId":"u1","question":"What theme does the user prefer?"}'
```

## Running LongMemEval

The dataset is not vendored. Fetch either official split from HuggingFace:

```bash
mkdir -p data
curl -sSL -o data/longmemeval_oracle.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_oracle
curl -sSL -o data/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s
```

`oracle` is 15MB and carries only the evidence sessions — use it to shake out the loop
cheaply. `s` is 266MB with ~50 sessions per question and is the headline benchmark.

Then:

```bash
export LONGMEMEVAL_PATH=data/longmemeval_s.json

# Small slice first — one instance ingests ~48 sessions
node scripts/run-eval.mjs --dataset $LONGMEMEVAL_PATH --limit 5

# One question type
node scripts/run-eval.mjs --dataset $LONGMEMEVAL_PATH --types knowledge-update

# Full run. Streams to JSONL and resumes on re-invocation, which matters
# because a 500-question run ingests ~24,000 sessions.
node scripts/run-eval.mjs --dataset $LONGMEMEVAL_PATH --out results/s-full.jsonl
```

Scoring: abstention instances (`question_id` ending `_abs`) are correct only if the system
abstained. Answerable instances are graded by normalised string match, falling back to a
Claude judge — matching LongMemEval's own LLM-as-judge metric. Session-level recall is
reported alongside accuracy.

Each instance is namespaced under its own `question_id` as the user id, so 500 haystacks
share one graph without bleeding into each other.

## Third-party attribution

| Source | Use | Licence |
|---|---|---|
| [HydraDB](https://github.com/hydra-db/hydradb) | Graph database | see upstream repo |
| [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) | Primary evaluation set | see upstream repo |
| LongMemEval-V2 / [BEAM](https://github.com/mohammadtavakoli78/BEAM) | Planned harder splits | see upstream repos |
| [Anthropic Claude API](https://docs.anthropic.com) (`@anthropic-ai/sdk`) | Fact extraction, query planning, answer synthesis, eval judging | MIT (SDK) |
| Zep / mem0 published figures | Baseline rows in the comparison table, as reported by their authors | — |
| Next.js, React, Tailwind CSS, Framer Motion, lucide-react, Geist | App framework and UI | MIT / Apache-2.0 |

No embedding or vector API is used, deliberately.

## HydraDB notes

`HYDRADB-NOTES.md` records the wire contract as verified against a live node, including
constraints the published docs do not state — the request field is `parameters` not
`params`, rows are positional and type-tagged, standalone vertex `MERGE` is rejected,
`UNWIND` edge writes require one label per endpoint plus an inline relationship id, and
`relTypes` must be a literal rather than a parameter. Read it before editing any Cypher in
`src/lib/`.

## Status

See `completion.md` for what is built, what is verified live, and what remains.

## Licence

MIT — see `LICENSE`.
