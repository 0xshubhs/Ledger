# Completion — track3 (agent memory)

Tracks what's actually built vs. what plan.md describes. Updated as work lands.

## Done

- [x] Landing page (full: navbar, hero, marquee, bento grid, feature cards, how-it-works, benchmarks, pricing, CTA, footer) — branded "track3"
- [x] `src/lib/hydradb.ts` — HTTP JSON query client (`POST /v1/graphs/{graph}/query`), causal/strong consistency, `checkHealth()` against `/readyz`
- [x] `src/lib/id.ts` — `stableId()`: deterministic string → non-negative integer (SHA-256, 48-bit), since HydraDB vertex ids must be non-negative integers
- [x] `src/lib/memory.ts` — graph domain logic:
  - `ingestSession()` — writes User/Session/Message vertices + HAS_SESSION/CONTAINS edges, two-pass UNWIND (upsert-then-connect, no `WITH` threading)
  - `writeFact()` — knowledge-update semantics: if the current fact's object changed, closes the old fact (`valid_to = new.valid_from`) and links `SUPERSEDES`, rather than overwriting
  - `getCurrentFact()` / `getFactHistory()` — current-truth and full-history reads
  - `multiHopFromEntity()` — wraps `algo.SSpaths` for cross-session reasoning
- [x] `src/lib/extract.ts` — Claude-based fact/entity extraction from a transcript (`claude-sonnet-5`), JSON-only prompt with defensive parsing
- [x] API routes: `GET /api/health`, `POST /api/ingest` (transcript → extract → write), `POST /api/query` + `GET /api/query?entity=` (current/history/multi-hop)
- [x] `npx tsc --noEmit` clean
- [x] `npm run build` clean — all 3 routes registered as dynamic (ƒ), landing page static (○)
- [x] `.env.example`

## Not done yet

- [ ] **Live verification against a running HydraDB node.** Docker daemon wasn't up on this machine during this session (`docker info` never returned ready after ~2 min), so none of the Cypher in `memory.ts` has been run against a real graph-node. Everything is modeled closely on the exact examples in HydraDB's `cypher-compat.md` (two-pass UNWIND, `MERGE {id}` then `SET`, no `WITH` chaining, `valid_to = 0` sentinel instead of unsupported `IS NULL`), but "modeled on the docs" is not the same as "confirmed working." **This is the top priority next step.**
- [ ] The HTTP response envelope (`hydradb.ts`'s `rows`/`bookmark` parsing) is inferred from the README's one curl example, not confirmed. May need adjustment once a real response is seen.
- [ ] `LongMemEval` dataset harness — nothing wired up yet to actually run the benchmark and produce the plan's target accuracy numbers. `/api/eval` mentioned in plan.md doesn't exist yet.
- [ ] No UI wiring — the landing page doesn't call any of these API routes yet (no demo transcript box, no "why this answer" graph panel).
- [ ] `Entity` merge on lowercased name is naive — no real entity resolution (e.g. "Sam" vs "@soham") despite that being called out as a hard part in the track brief.

## How to verify locally once Docker is up

```bash
mkdir -p .hydradb/store .hydradb/cache
printf '%s\n' 'local-development-token-32-bytes' > .hydradb/auth-token
docker run --rm --user "$(id -u):$(id -g)" \
  -p 7687:7687 -p 8443:8443 -p 9090:9090 \
  -v "$PWD/.hydradb:/data" \
  -e CLOUD_PROVIDER=local -e LOCAL_PATH=/data/store \
  -e GRAPH_NAMESPACE=default -e GRAPH_ID=default \
  -e GRAPH_CELL_ID=cell-0 -e GRAPH_CELLS=cell-0 -e GRAPH_NODE_ID=node-0 \
  -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
  -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_DATA_CACHE_DIR=/data/cache \
  -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
  -e GRAPH_ALLOW_PLAINTEXT=true -e RUST_MIN_STACK=33554432 \
  ghcr.io/hydra-db/hydradb:latest

# separate shell
cp .env.example .env.local   # fill in ANTHROPIC_API_KEY
npm run dev
curl localhost:3001/api/health
curl -X POST localhost:3001/api/ingest -H 'content-type: application/json' -d '{
  "userExternalId": "u1", "sessionIndex": 0,
  "messages": [{"role":"user","content":"I prefer dark mode.","ts": 1000}]
}'
curl -X POST localhost:3001/api/query -H 'content-type: application/json' -d '{
  "userExternalId": "u1", "subject": "user", "predicate": "prefers"
}'
```
