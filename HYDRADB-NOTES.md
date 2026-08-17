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

## Consistency

`"consistency": "causal" | "strong"` in the request body. Every response carries
a `bookmark`; feeding it back into a later request is how read-your-writes works
without paying for `strong` on every call.

## Reproduce

```bash
docker run -d --name hydradb-test --user "$(id -u):$(id -g)" \
  -p 7687:7687 -p 8443:8443 -p 9090:9090 -v "$PWD/.hydradb-test:/data" \
  -e CLOUD_PROVIDER=local -e LOCAL_PATH=/data/store \
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
