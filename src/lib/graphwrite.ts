import { stableId } from "./id"
import type { HydraSession } from "./hydradb"

/**
 * The two batch-write shapes HydraDB actually executes, factored out so every
 * caller gets them right. Both were verified against a live graph-node; the
 * constraints below are enforced by the parser and are *not* all documented in
 * cypher-compat.md, so they're worth stating here:
 *
 *  1. There is no way to create a standalone vertex outside `UNWIND`. A plain
 *     `MERGE (n {id: $x})` is rejected ("only one-hop edge patterns are
 *     executable in Query engine MERGE"), and `MERGE ... SET ...` in one
 *     statement is rejected too ("MERGE with following clauses"). So even a
 *     single vertex goes through the UNWIND form with a one-row batch.
 *  2. An `UNWIND` edge write requires *exactly one label* on each endpoint
 *     pattern, and an inline `{id: row.<field>}` identity property on the
 *     relationship. Without the labels: "UNWIND MATCH CREATE endpoints require
 *     exactly one label". Without the relationship id: "UNWIND relationship
 *     MERGE requires id: row.<field>". The inline id is also what makes repeat
 *     ingestion idempotent — verified: two identical batches leave count(*) = 1.
 */

/** Deterministic identity for an edge, so re-ingesting dedupes instead of duplicating. */
export function edgeId(type: string, from: number, to: number): number {
  return stableId(`edge:${type}:${from}:${to}`)
}

export interface VertexRow {
  vertex: number
  [property: string]: string | number | boolean
}

/**
 * Upserts a batch of vertices carrying one label. Property columns are taken
 * from the first row, so every row in a batch must carry the same fields —
 * `UNWIND` reads named fields off each row map and a missing one is an error.
 */
export async function writeVertices(
  session: HydraSession,
  label: string,
  rows: VertexRow[]
): Promise<number> {
  if (rows.length === 0) return 0

  const properties = Object.keys(rows[0]).filter((key) => key !== "vertex")
  const setClauses = [`n:${label}`, ...properties.map((p) => `n.${p} = row.${p}`)].join(", ")

  await session.run(`UNWIND $rows AS row MERGE (n {id: row.vertex}) SET ${setClauses}`, { rows })
  return rows.length
}

export interface EdgeRow {
  from: number
  to: number
  [property: string]: string | number | boolean
}

/**
 * Connects a batch of already-written vertices. `fromLabel`/`toLabel` are
 * mandatory because the parser requires exactly one label per endpoint.
 */
export async function writeEdges(
  session: HydraSession,
  fromLabel: string,
  relType: string,
  toLabel: string,
  rows: EdgeRow[]
): Promise<number> {
  if (rows.length === 0) return 0

  const properties = Object.keys(rows[0]).filter((key) => key !== "from" && key !== "to")
  const payload = rows.map((row) => ({ ...row, rel: edgeId(relType, row.from, row.to) }))

  const setClause = properties.length
    ? ` SET ${properties.map((p) => `r.${p} = row.${p}`).join(", ")}`
    : ""

  await session.run(
    `UNWIND $rows AS row
     MATCH (s:${fromLabel} {id: row.from}), (d:${toLabel} {id: row.to})
     MERGE (s)-[r:${relType} {id: row.rel}]->(d)${setClause}`,
    { rows: payload }
  )
  return payload.length
}

/**
 * HydraDB has no `IN` operator and no multi-statement requests, so a batch of
 * writes is a sequence of round trips. Chunking keeps any single request body
 * within the node's max_body_bytes while still amortising per-statement cost.
 */
export function chunk<T>(items: T[], size = 500): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}
