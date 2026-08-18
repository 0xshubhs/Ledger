"use client"

import { useMemo, useState } from "react"

export interface GraphNode {
  id: number
  labels: string[]
  properties: Record<string, unknown>
}

export interface GraphRelationship {
  id: number
  type: string
  src: number
  dst: number
  properties: Record<string, unknown>
}

export interface GraphPath {
  nodes: GraphNode[]
  relationships: GraphRelationship[]
}

/** Column colour per label — the same red/black palette the console uses. */
const LABEL_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  Fact: { fill: "#F1F3FF", stroke: "#0001FC", text: "#0001FC" },
  Entity: { fill: "#FFFFFF", stroke: "#000000", text: "#000000" },
  Message: { fill: "#FFFBEB", stroke: "#B45309", text: "#B45309" },
  Session: { fill: "#FFFFFF", stroke: "#000000", text: "#000000" },
  User: { fill: "#F1FFF5", stroke: "#0A7B34", text: "#0A7B34" },
}

const COLUMN_WIDTH = 208
const NODE_WIDTH = 168
const NODE_HEIGHT = 46
const ROW_HEIGHT = 72
const PADDING = 16

function label(node: GraphNode): string {
  return node.labels[0] ?? "Node"
}

function caption(node: GraphNode): string {
  const props = node.properties
  if (typeof props.predicate === "string") {
    return `${props.predicate}: ${props.object ?? ""}`
  }
  if (typeof props.name === "string") return props.name
  if (typeof props.content === "string") return props.content
  if (typeof props.external_id === "string") return props.external_id
  if (typeof props.session_index === "number") return `session ${props.session_index}`
  return String(node.id)
}

interface Placed {
  node: GraphNode
  column: number
  row: number
}

/**
 * Draws the multi-hop paths `algo.SSpaths` returned around one entity.
 *
 * Layout is derived from the graph rather than simulated: a node's column is its
 * hop distance from the entity, which is exactly what the paths encode, so the
 * picture reads left-to-right as "the entity, the facts about it, the turns that
 * asserted them, the sessions they came from." A force-directed layout would
 * scramble that into something prettier and less true — distance from the left
 * edge is the whole point of the diagram.
 *
 * A `SUPERSEDES` edge between two Fact boxes is the knowledge update made
 * visible: both facts are still there, and the arrow says which replaced which.
 */
export function MemoryGraph({
  paths,
  sourceId,
  highlight,
}: {
  paths: GraphPath[]
  /** The entity the traversal started from — drawn first, in the left column. */
  sourceId: number
  highlight?: number | null
}) {
  const [hovered, setHovered] = useState<number | null>(null)

  const { placed, edges, width, height } = useMemo(() => {
    const nodeById = new Map<number, GraphNode>()
    const distance = new Map<number, number>()
    const edgeSet = new Map<string, { from: number; to: number; type: string }>()

    for (const path of paths) {
      for (const node of path.nodes) nodeById.set(node.id, node)

      // A path from SPpaths runs service → … → compromised version, and one
      // from SSpaths runs the other way. Orienting on the known source id keeps
      // both in the same left-to-right frame instead of guessing from order.
      const ordered =
        path.nodes[0]?.id === sourceId ? path.nodes : [...path.nodes].reverse()
      ordered.forEach((node, index) => {
        const existing = distance.get(node.id)
        if (existing === undefined || index < existing) distance.set(node.id, index)
      })

      for (const rel of path.relationships) {
        edgeSet.set(`${rel.src}:${rel.dst}:${rel.type}`, {
          from: rel.src,
          to: rel.dst,
          type: rel.type,
        })
      }
    }

    const byColumn = new Map<number, GraphNode[]>()
    for (const [id, node] of nodeById) {
      const column = distance.get(id) ?? 0
      const list = byColumn.get(column) ?? []
      list.push(node)
      byColumn.set(column, list)
    }

    const placed = new Map<number, Placed>()
    let maxRows = 0
    for (const [column, nodes] of [...byColumn.entries()].sort((a, b) => a[0] - b[0])) {
      nodes
        .sort((a, b) => caption(a).localeCompare(caption(b)))
        .forEach((node, row) => placed.set(node.id, { node, column, row }))
      maxRows = Math.max(maxRows, nodes.length)
    }

    const columns = Math.max(1, byColumn.size)
    return {
      placed,
      edges: [...edgeSet.values()],
      width: columns * COLUMN_WIDTH + PADDING * 2,
      height: Math.max(1, maxRows) * ROW_HEIGHT + PADDING * 2,
    }
  }, [paths, sourceId])

  if (paths.length === 0) return null

  const centreOf = (id: number) => {
    const p = placed.get(id)
    if (!p) return null
    return {
      x: PADDING + p.column * COLUMN_WIDTH + NODE_WIDTH / 2,
      y: PADDING + p.row * ROW_HEIGHT + NODE_HEIGHT / 2,
    }
  }

  // Which nodes light up: the hovered node's chain, or the service the list
  // selected. Everything else drops to a muted stroke so one exposure can be
  // followed through a diagram with several.
  const focus = hovered ?? highlight ?? null
  const onFocusChain = new Set<number>()
  if (focus !== null) {
    for (const path of paths) {
      if (!path.nodes.some((n) => n.id === focus)) continue
      for (const node of path.nodes) onFocusChain.add(node.id)
    }
  }
  const dimmed = (id: number) => focus !== null && !onFocusChain.has(id)

  return (
    <div className="overflow-x-auto border-2 border-black bg-neutral-50">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block min-w-full"
        role="img"
        aria-label="Multi-hop paths from the selected entity through facts, messages and sessions"
      >
        <defs>
          <marker
            id="blast-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#000000" />
          </marker>
        </defs>

        {edges.map((edge) => {
          const from = centreOf(edge.from)
          const to = centreOf(edge.to)
          if (!from || !to) return null
          const faded = dimmed(edge.from) || dimmed(edge.to)
          const midX = (from.x + to.x) / 2
          return (
            <g key={`${edge.from}-${edge.to}-${edge.type}`} opacity={faded ? 0.15 : 1}>
              <path
                d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
                fill="none"
                stroke="#000000"
                strokeWidth={1.5}
                markerEnd="url(#blast-arrow)"
              />
              <text
                x={midX}
                y={(from.y + to.y) / 2 - 6}
                textAnchor="middle"
                className="fill-neutral-500 text-[9px] font-bold uppercase tracking-wider"
              >
                {edge.type}
              </text>
            </g>
          )
        })}

        {[...placed.values()].map(({ node, column, row }) => {
          const style = LABEL_STYLE[label(node)] ?? LABEL_STYLE.Entity
          const x = PADDING + column * COLUMN_WIDTH
          const y = PADDING + row * ROW_HEIGHT
          const isSource = node.id === sourceId
          return (
            <g
              key={node.id}
              opacity={dimmed(node.id) ? 0.25 : 1}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              style={{ cursor: "pointer" }}
            >
              <rect
                x={x}
                y={y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                fill={style.fill}
                stroke={style.stroke}
                strokeWidth={isSource ? 3 : 2}
              />
              <text
                x={x + 8}
                y={y + 17}
                className="text-[9px] font-bold uppercase tracking-[0.2em]"
                fill={style.text}
              >
                {label(node)}
                {isSource ? " · queried" : ""}
                {node.properties.valid_to !== undefined && node.properties.valid_to !== 0
                  ? " · superseded"
                  : ""}
              </text>
              <text x={x + 8} y={y + 34} className="text-[11px] font-bold" fill="#000000">
                {caption(node).length > 22 ? caption(node).slice(0, 21) + "…" : caption(node)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
