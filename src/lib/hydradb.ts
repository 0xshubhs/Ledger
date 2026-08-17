export type Consistency = "causal" | "strong"

export interface HydraQueryOptions {
  params?: Record<string, unknown>
  consistency?: Consistency
  bookmark?: string
  cellId?: string
}

export interface HydraQueryResult<T = Record<string, unknown>> {
  rows: T[]
  bookmark?: string
  raw: unknown
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

/**
 * Runs a single OpenCypher statement against a HydraDB graph-node over the
 * HTTPS JSON query API: POST /v1/graphs/{graph}/query (see HydraDB README,
 * "Verify a running node"). Each call is one bounded server operation —
 * HydraDB does not expose multi-statement explicit transactions over HTTP.
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
      params,
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
    throw new Error(`HydraDB query failed (${res.status}): ${text.slice(0, 500)}`)
  }

  // NOTE: the exact response envelope (row shape, bookmark field name) is
  // inferred from the HydraDB README's curl example, not yet confirmed
  // against a live node. See completion.md — "Verify HTTP response envelope"
  // is the first thing to check once a graph-node is reachable.
  const responseObj = body as { rows?: T[]; bookmark?: string }
  return {
    rows: responseObj.rows ?? (Array.isArray(body) ? (body as T[]) : []),
    bookmark: responseObj.bookmark,
    raw: body,
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
