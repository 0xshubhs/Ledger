# HydraDB HTTP contract — verified live

Tested 2026-08-17 against `ghcr.io/hydra-db/hydradb:latest` running locally
(container `hydradb-test`, HTTP `:8443`, admin `:9090`). Every line below was
confirmed by a real request, not read off the docs.

## Request body

```json
{
  "cell_id": "cell-0",
  "query": "...",
  "parameters": { "name": value },
  "consistency": "causal" | "strong",
  "bookmark": "sgk:...",
  "query_id": "...", "read_epoch": 0, "timeout_ms": 0, "page_size": 0, "cursor": 0
}
```

**The parameter field is `parameters`, NOT `params`.** Source of truth:
`src/client/http.rs:283` (`HttpQueryRequestBody`). Sending `params` yields
`400 {"error":{"code":"invalid_request","message":"missing OpenCypher query parameter $rows"}}`.

Headers: `Authorization: Bearer <token>`, `X-Graph-Namespace: default`,
`Content-Type: application/json`.

## Response body

```json
{
  "query_id": "http-query-1",
  "columns": ["id", "object"],
  "rows": [[{"type":"vertex_id","value":2}, {"type":"string","value":"dark"}]],
  "read_epoch": 1,
  "next_cursor": null,
  "bookmark": "sgk:1:64656661756c74:...:1"
}
```

`rows` is **positional** — `Vec<Vec<TypedValue>>`, aligned to `columns`. It is
NOT an array of alias-keyed objects. Every value is wrapped as `{type, value}`.

Value type tags (`src/client/http.rs:314`): `null`, `vertex_id`, `integer`,
`signed_integer`, `float`, `boolean`, `string`, `list`, `path`.

Errors are `{"error":{"code","message","owner?}}` with a 4xx status.

### Path values

`{"type":"path","value":{...}}` where value is:

```json
{
  "nodes": [{"id":303,"labels":["PackageVersion"],"properties":{"version":{"String":"4.19.2"}}}],
  "relationships": [{"id":4,"edge_type":"RESOLVES_TO","src":302,"dst":303,"properties":{"id":{"Integer":9101}}}]
}
```

Note the **inconsistency**: inside a path, properties use Rust-style
capitalised tags (`{"String": ...}`, `{"Integer": ...}`), unlike the
snake_case `{"type","value"}` envelope at the top level. A client needs two
unwrappers.

## Writes — what actually executes

| Form | Verdict |
|---|---|
| `MERGE (u {id:$x}) SET u:User, u.p = $y` | ❌ `MERGE with following clauses is not executable in Query engine` |
| `MERGE (u {id:$x})` (lone vertex) | ❌ `only one-hop edge patterns are executable in Query engine MERGE` |
| `MERGE (u {id:$a})-[:REL]->(v {id:$b})` | ✅ creates both endpoints + edge |
| `MATCH (u {id:$x}) SET u:User, u.p = $y` | ✅ (silently 200 + 0 rows if nothing matched) |
| `MATCH (a:A {id:$x}), (b:B {id:$y}) MERGE (a)-[:REL]->(b)` | ❌ `write query is not executable by the mutation engine` |
| `CREATE (a {id:1})-[:REL]->(b {id:2})` | ✅ |

**There is no way to create a standalone vertex outside `UNWIND`.** Use the
UNWIND batch form, or attach it to a one-hop `MERGE` edge pattern.

## UNWIND batches — the only real ingestion path

Vertex upsert — ✅ works, unlabeled `MERGE` + `SET` label/props:

```cypher
UNWIND $rows AS row MERGE (n {id: row.vertex})
  SET n:Message, n.role = row.role, n.ts = row.ts
```

Edge write — **two hard requirements**, both undocumented in `cypher-compat.md`:

1. Both endpoints need **exactly one label**.
   Unlabeled → `UNWIND MATCH CREATE endpoints require exactly one label`
2. The relationship needs an **inline `{id: row.<field>}`** identity property.
   Missing → `UNWIND relationship MERGE requires id: row.<field>`

```cypher
-- ✅ correct
UNWIND $rows AS row
  MATCH (s:PackageVersion {id: row.source_vertex}), (d:PackageVersion {id: row.destination_vertex})
  MERGE (s)-[r:RESOLVES_TO {id: row.rel_vertex}]->(d)
  SET r.requirement = row.requirement
```

Verified idempotent: running the identical batch twice leaves `count(*) = 1`,
so the inline rel id is what dedupes. Without it the statement will not parse
at all, so parallel-edge duplication is impossible by construction.

## Reads — confirmed accepted

All of these parse and execute:

```cypher
MATCH (f:Fact) WHERE f.user_id = $u AND f.subject = $s AND f.valid_to = $v
  RETURN f.id AS id, f.object AS object, f.valid_from AS validFrom
  ORDER BY f.valid_from DESC LIMIT 1        -- ORDER BY <binding>.<prop> IS accepted
MATCH (m:Maintainer)-[:MAINTAINS]->(p:Package) WHERE p.id = $pkgId
  RETURN DISTINCT m.id AS id, m.name AS name
MATCH (p:Package)-[r:NAME_SIMILAR_TO]->(o:Package) WHERE p.id = $pkgId
  RETURN o.id AS id, o.name AS name, r.distance AS distance ORDER BY distance
```

`ORDER BY f.valid_from` works even though the docs only promise a projected
alias / `<binding>.id`. Relationship-property projection and aliasing work.

## Path procedures

**`relTypes` must be a literal array in the query string.** Passing it as a
parameter fails: `composite parameter $relTypes is only supported as an UNWIND
input`. Scalar params (`sourceNode`, `maxLen`, `pathCount`) are fine.

**Multi-type `relTypes` works** — the multi-hop, mixed-edge-type traversal both
projects depend on is real:

```cypher
CALL algo.SSpaths({sourceNode: $sourceId,
                   relTypes: ['RESOLVES_TO','PINS','HAS_LOCKFILE'],
                   relDirection: 'both', maxLen: $maxLen, pathCount: $pathCount})
  YIELD path RETURN path
```

Verified end-to-end: compromised `PackageVersion` 303 → `RESOLVES_TO` → 302 →
`PINS` → `Lockfile` 304 → `HAS_LOCKFILE` → `Project` 305. `relDirection:'both'`
correctly walks edges against their stored direction, which is what makes
reverse-dependency closure work.

`algo.SPpaths` with `YIELD path, pathWeight, pathCost` returns the exact
explanation path (weight 3 for the 3-hop chain above).

### `relDirection: 'incoming'` — and why it matters

Accepted values are exactly `'incoming'`, `'outgoing'`, `'both'`; anything else
is a parse error. `'incoming'` walks edges strictly against their stored
direction, which is what a reverse-dependency closure needs. `'both'` also finds
dependents, but from each one it walks back *down* into that dependent's own
dependencies, so the traversal fans out over the whole graph — at `maxLen: 6` on
a 3,000-version graph it died with `client_cursor_buffer_bytes rejected by
admission control: actual 67109502 exceeds limit 67108864`.

### `pathCount` is capped at 1024, silently

Measured on one vertex, same query, only `pathCount` varying:

| requested | returned |
|---|---|
| 100 | 100 |
| 1024 | 1024 |
| 2000 | **1024** |
| 5000 | **1024** |

Above 100,000 the request is rejected outright (`native_path_count rejected by
admission control: actual 200000 exceeds limit 100000`), which reads as though
any value below that is honoured. It is not. Nothing in the response marks the
result as truncated — 1024 paths look exactly like a complete answer.

Consequence for any traversal that has to be exhaustive: one path call cannot be
the answer. A caller that needs completeness has to treat exactly 1024 paths as
truncated and re-expand a level at a time — `multiHopFromEntity` in
`src/lib/memory.ts` is explicitly an exploration aid rather than an exhaustive
one for this reason.

## Query planning: `WHERE n.id = $x` scans, `{id: $x}` seeks

The single biggest performance finding here, and it is invisible in the query
text. Binding a vertex by id inside the pattern hits the id index; the same
predicate in a `WHERE` clause does not, and the engine falls back to scanning
the label.

Measured on the same 3,000-version graph, same results returned:

| query | time |
|---|---|
| `MATCH (a:PackageVersion)-[:RESOLVES_TO]->(b:PackageVersion) WHERE b.id = $id` | 26.6s |
| `MATCH (dep:PackageVersion {id: $id})<-[:RESOLVES_TO]-(dependent:PackageVersion)` | 2.3s |
| `CALL algo.SSpaths({sourceNode: $id, ..., maxLen: 1})` | 0.086s |

The same holds for a chained multi-hop read (748 rows returned either way):

| query | time |
|---|---|
| `MATCH (a:A)-[...]->(d) WHERE a.id = $id` | 41.6s |
| `MATCH (a:A {id: $id})-[...]->(d)` | 3.0s |

The fact queries in `src/lib/memory.ts` filter on `f.user_id`, which is a
property and not the vertex id, so no seek is available to them either way —
but any lookup that *does* have an id should put it in the pattern.

So: bind ids in the pattern, and prefer a native path procedure over a pattern
match when what you want is a neighbourhood. Reverse arrows (`<-[:REL]-`) parse
and work.

The scanning form does not merely get slow — past a certain graph size it stops
returning at all: `408 query_timeout: client_query_runtime exceeded query timeout
after 120000 ms` (the node's `GRAPH_MAX_QUERY_RUNTIME_MS`). Same query, same
data, id moved into the pattern: hundreds of milliseconds.

## Write cost grows with total graph size

There is no way to create a standalone vertex except the unlabeled
`UNWIND $rows AS row MERGE (n {id: row.vertex}) SET n:Label, ...` form, and that
form appears to cost more as the graph grows — the label that would narrow it is
applied by the `SET`, after the `MERGE` has already matched.

Measured with the same two-message write, same client, same code:

| graph | write time |
|---|---|
| empty node | **93ms** |
| node holding ~1.5M vertices from another workload | **6,258ms** |

That is a 67x difference on a write whose own payload never changed. Two
workloads sharing one graph do not just compete for CPU; the larger one taxes
every write the smaller one makes. Give an ingest-heavy job its own graph-node.

## Concurrency

The node is not the serial bottleneck it looks like from one connection.
Single-hop expansions, warm:

| in flight | throughput |
|---|---|
| 1 | 27/s |
| 8 | 857/s |
| 24 | 1171/s |
| 48 | 1500/s |

## Admission control

Several limits are enforced per statement and reported as
`<limit_name> rejected by admission control: actual N exceeds limit M`:

| limit | value | what trips it |
|---|---|---|
| `native_path_count` | 100,000 | `pathCount` above 100k on a path procedure |
| `native_path_edges` | 1,000,000 | a path procedure whose traversal would touch >1M edges |
| `client_cursor_buffer_bytes` | 67,108,864 | a deep/wide traversal's result set |
| `delete_vertex_scan_relationships` | 1,000,000 | `DETACH DELETE` on a graph with ~1M edges |

`native_path_edges` is the one that ends the "one traversal answers it" idea
outright. On an 84,163-version graph, the single `algo.SSpaths` call with
`relDirection: 'both'` does not truncate — it is refused:
`native_path_edges rejected by admission control: actual 1000034 exceeds limit
1000000`. The same graph answers the lockfile-pattern query in 124ms.
Expanding one hop at a time with `relDirection: 'incoming'` stays far under the
limit, which is why the closure is enumerated rather than asked for in one call.

The `delete_vertex_scan_edges` one is the other surprise: `DETACH DELETE` appears to scan relationships
graph-wide rather than per vertex, so a batch that deletes fine on a small graph
fails on a large one no matter how few vertices it names. Emptying a big graph is
therefore not a cheap operation — plan for namespacing a new run instead of
clearing the old one.

There is also a runtime ceiling, `GRAPH_MAX_QUERY_RUNTIME_MS` (120s by default),
returned as `408 query_timeout`.

## Deletes

`MATCH (n {id: $x}) DELETE n`, `DETACH DELETE`, `REMOVE n:Label` and the
`UNWIND $rows AS row MATCH (n {id: row.vertex}) DETACH DELETE n` batch form all
parse and execute — useful for taking a test namespace back out of a shared
graph, since nothing here deletes facts in normal operation (a superseded fact
is kept, not removed).

## Consistency

`"consistency": "causal" | "strong"` in the request body. Every response carries
a `bookmark`; feeding it back into a later request is how read-your-writes works
without paying for `strong` on every call.

## Reproduce

```bash
docker run -d --name hydradb-test --user "$(id -u):$(id -g)" \
  -p 7687:7687 -p 8443:8443 -p 9090:9090 -v "$PWD/.hydradb-test:/data" \
  -e CLOUD_PROVIDER=memory \
  -e GRAPH_NAMESPACE=default -e GRAPH_ID=default \
  -e GRAPH_CELL_ID=cell-0 -e GRAPH_CELLS=cell-0 -e GRAPH_NODE_ID=node-0 \
  -e GRAPH_BOLT_NODE_ADDRESSES=node-0=127.0.0.1:7687 \
  -e GRAPH_ADVERTISED_BOLT_ADDR=127.0.0.1:7687 \
  -e GRAPH_DATA_CACHE_DIR=/data/cache \
  -e GRAPH_AUTH_TOKEN_FILE=/data/auth-token \
  -e GRAPH_ALLOW_PLAINTEXT=true -e RUST_MIN_STACK=33554432 \
  ghcr.io/hydra-db/hydradb:latest
# readiness: curl -sf http://127.0.0.1:9090/readyz
```

`RUST_MIN_STACK=33554432` is mandatory — without it the node serves `/readyz`
and then aborts with a stack overflow on the first query.

## Object store: `memory`, not `local`

`CLOUD_PROVIDER=local` is what the HydraDB README documents, and it works right
up until SlateDB needs a conditional write on its manifest:

```
object store error: Operation `put_opts` with mode `PutMode::Update`
not yet implemented by LocalFileSystem(file:///data/store)
```

The HTTP layer reports this as a bare `500 internal query execution error` on
whichever statement happened to trigger the flush, with the real cause only in
the node's own log — so it reads like a bug in your Cypher. A few hundred writes
survive; sustained ingestion does not.

`CLOUD_PROVIDER=memory` has no such limitation (verified: 564 messages across 66
sessions, zero errors) but is not durable across a container restart. For a long
run keep the container up, or use an S3-compatible store such as MinIO.
