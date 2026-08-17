"use client"

import { useEffect, useState } from "react"

// The retrieval paths the query planner can actually take, with the Cypher
// shape each one resolves to. Verified against a live graph-node.
const CHANNELS = [
  { name: "CURRENT_TRUTH", status: "WIRED", latency: "valid_to = 0" },
  { name: "FACT_HISTORY", status: "WIRED", latency: "ORDER BY valid_from" },
  { name: "ENTITY_FANOUT", status: "WIRED", latency: "(:Fact)-[:ABOUT]->" },
  { name: "MULTI_HOP", status: "WIRED", latency: "algo.SSpaths" },
  { name: "ABSTENTION", status: "WIRED", latency: "0 rows ⇒ stop" },
]

export function StatusCard() {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 2000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b-2 border-foreground px-4 py-2">
        <span className="text-[10px] tracking-widest text-muted-foreground uppercase">retrieval.channels</span>
        <span className="text-[10px] tracking-widest text-muted-foreground">{`TICK:${String(tick).padStart(4, "0")}`}</span>
      </div>
      <div className="flex-1 flex flex-col p-4 gap-0">
        <div className="grid grid-cols-3 gap-2 border-b border-border pb-2 mb-2">
          <span className="text-[9px] tracking-[0.15em] uppercase text-muted-foreground">Channel</span>
          <span className="text-[9px] tracking-[0.15em] uppercase text-muted-foreground">Status</span>
          <span className="text-[9px] tracking-[0.15em] uppercase text-muted-foreground text-right">Latency</span>
        </div>
        {CHANNELS.map((ch) => (
          <div key={ch.name} className="grid grid-cols-3 gap-2 py-2 border-b border-border last:border-none">
            <span className="text-xs font-mono text-foreground">{ch.name}</span>
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 bg-[#0001FC]" />
              <span className="text-xs font-mono text-muted-foreground">{ch.status}</span>
            </div>
            <span className="text-xs font-mono text-foreground text-right">{ch.latency}</span>
          </div>
        ))}
        <div className="mt-auto pt-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] tracking-[0.15em] uppercase text-muted-foreground">Retrieval Paths</span>
            <span className="text-[9px] font-mono text-foreground">4 / 4 wired</span>
          </div>
          <div className="h-2 w-full border border-foreground">
            <div className="h-full bg-foreground" style={{ width: "100%" }} />
          </div>
        </div>
      </div>
    </div>
  )
}
