export type Consistency = "causal" | "strong"

export interface HydraQueryOptions {
  params?: Record<string, unknown>
  consistency?: Consistency
  bookmark?: string
  cellId?: string
}

export interface HydraQueryResult<T = Record<string, unknown>> {
  rows: T[]
  columns: string[]
  bookmark?: string
  readEpoch?: number
}

const QUERY_URL = process.env.HYDRADB_HTTP_URL ?? "http://127.0.0.1:8443"
const ADMIN_URL = process.env.HYDRADB_ADMIN_URL ?? "http://127.0.0.1:9090"
const NAMESPACE = process.env.HYDRADB_NAMESPACE ?? "default"
const GRAPH = process.env.HYDRADB_GRAPH ?? "default"
const DEFAULT_CELL = process.env.HYDRADB_CELL_ID ?? "cell-0"

function authToken(): string {
  const token = process.env.HYDRADB_AUTH_TOKEN
  if (!token) {
    throw new Error("Missing HYDRADB_AUTH_TOKEN environment variable")
  }
  return token
}

/** A node as it appears inside a returned path. */
export interface PathNode {
  id: number
  labels: string[]
  properties: Record<string, unknown>
}

/** A relationship as it appears inside a returned path. */
export interface PathRelationship {
  id: number
  type: string
  src: number
  dst: number
  properties: Record<string, unknown>
}

export interface GraphPath {
  nodes: PathNode[]
  relationships: PathRelationship[]
}

/**
 * A single cell of the wire response. graph-node tags every scalar it returns
 * (`{"type":"vertex_id","value":2}`) — see HttpQueryValue in src/client/http.rs.
 */
interface WireValue {
  type: string
  value: unknown
}

/** Raw path payload: property values here are tagged differently to top-level
 *  scalars — capitalised Rust variant names rather than snake_case `type`. */
interface WirePath {
  nodes?: { id: number; labels?: string[]; properties?: Record<string, unknown> }[]
  relationships?: {
    id: number
    edge_type: string
    src: number
    dst: number
    properties?: Record<string, unknown>
  }[]
}

/**
 * Unwraps the property encoding used *inside* a path payload, which is the
 * serde representation of the internal property enum: `{"String": "4.19.2"}`,
 * `{"Integer": 9101}`. This is deliberately not the same shape as the
 * top-level `{type, value}` envelope, so it needs its own unwrapper.
 */
function decodePathProperties(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(props ?? {})) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const variants = Object.values(raw as Record<string, unknown>)
      out[key] = variants.length === 1 ? variants[0] : raw
    } else {
      out[key] = raw
    }
  }
  return out
}

function decodePath(raw: WirePath): GraphPath {
  return {
    nodes: (raw.nodes ?? []).map((n) => ({
      id: n.id,
      labels: n.labels ?? [],
      properties: decodePathProperties(n.properties),
    })),
    relationships: (raw.relationships ?? []).map((r) => ({
      id: r.id,
      type: r.edge_type,
      src: r.src,
      dst: r.dst,
      properties: decodePathProperties(r.properties),
    })),
  }
}

/** Unwraps one tagged top-level value into a plain JS value. */
function decodeValue(cell: unknown): unknown {
  if (cell === null || typeof cell !== "object") return cell
  const { type, value } = cell as WireValue

  switch (type) {
    case "null":
      return null
    case "path":
      return decodePath(value as WirePath)
    case "list":
      return Array.isArray(value) ? value.map(decodeValue) : []
    default:
      // vertex_id | integer | signed_integer | float | boolean | string
      return value
  }
}

interface WireResponse {
  columns?: string[]
  rows?: unknown[][]
  bookmark?: string
  read_epoch?: number
}

/**
 * Runs a single OpenCypher statement against a HydraDB graph-node over the
 * HTTPS JSON query API: POST /v1/graphs/{graph}/query.
 *
 * Two wire details matter and are easy to get wrong — both verified against a
 * live node rather than taken from the docs:
 *
 *  - the parameter field is `parameters`, not `params` (HttpQueryRequestBody
 *    in src/client/http.rs). Sending `params` fails with "missing OpenCypher
 *    query parameter $x", which reads like a query bug rather than a body one.
 *  - `rows` is positional (`Vec<Vec<TypedValue>>`) and aligned to `columns`,
 *    not an array of alias-keyed objects, and every scalar is tagged. We zip
 *    the two back into plain objects here so callers see ordinary JS values.
 *
 * Each call is one bounded server operation — HydraDB accepts one statement
 * per request and commits it durably before returning.
 */
export async function runQuery<T = Record<string, unknown>>(
  query: string,
  options: HydraQueryOptions = {}
): Promise<HydraQueryResult<T>> {
  const { params, consistency = "causal", bookmark, cellId = DEFAULT_CELL } = options

  const res = await fetch(`${QUERY_URL}/v1/graphs/${GRAPH}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken()}`,
      "X-Graph-Namespace": NAMESPACE,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cell_id: cellId,
      query,
      ...(params ? { parameters: params } : {}),
      consistency,
      ...(bookmark ? { bookmark } : {}),
    }),
  })

  const text = await res.text()
  let body: unknown
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`HydraDB returned non-JSON response (${res.status}): ${text.slice(0, 500)}`)
  }

  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } }
    const detail = err.error?.message ?? text.slice(0, 500)
    throw new Error(`HydraDB query failed (${res.status} ${err.error?.code ?? "error"}): ${detail}`)
  }

  const wire = body as WireResponse
  const columns = wire.columns ?? []
  const rows = (wire.rows ?? []).map((cells) => {
    const row: Record<string, unknown> = {}
    columns.forEach((name, i) => {
      row[name] = decodeValue(cells[i])
    })
    return row as T
  })

  return { rows, columns, bookmark: wire.bookmark, readEpoch: wire.read_epoch }
}

/**
 * Threads a bookmark across a sequence of statements so a multi-statement
 * write (every batch ingest here is one) is read-your-writes correct without
 * paying for `strong` consistency on each individual call. HydraDB returns a
 * bookmark from every request; handing it back makes a `causal` read refresh
 * to at least that sequence.
 */
export class HydraSession {
  private bookmark?: string

  constructor(private readonly consistency: Consistency = "causal") {}

  async run<T = Record<string, unknown>>(
    query: string,
    params?: Record<string, unknown>,
    consistency?: Consistency
  ): Promise<HydraQueryResult<T>> {
    const result = await runQuery<T>(query, {
      params,
      consistency: consistency ?? this.consistency,
      bookmark: this.bookmark,
    })
    if (result.bookmark) this.bookmark = result.bookmark
    return result
  }

  /** The latest durable sequence observed, to hand to a follow-up reader. */
  get lastBookmark(): string | undefined {
    return this.bookmark
  }
}

/** Checks the graph-node admin listener's readiness endpoint (GET /readyz). */
export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ADMIN_URL}/readyz`)
    return res.ok
  } catch {
    return false
  }
}
