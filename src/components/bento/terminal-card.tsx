"use client"

import { useEffect, useState } from "react"

const LOG_LINES = [
  "> Initializing track3 agent runtime...",
  "> Loading memory graph index...",
  "> Entity resolution: enabled",
  "> Temporal versioning: git-style",
  "> Interaction received: USER_MESSAGE",
  "> Encoding: semantic + emotional + context [OK]",
  "> Emotion detected: CONFIDENT",
  "> Entity extracted: ['User', 'Preference', 'Dark Mode']",
  "> Episode boundary: detected [NEW_EPISODE]",
  "> Writing to graph: 3 nodes, 2 edges [STORED]",
  "> Consolidation check: similarity > 0.85 [MERGE]",
  "> Retrieval query: 'user UI preferences'",
  "> Channels: semantic(0.6) graph(0.4) RRF fused",
  "> Result: 4 memories, latency 42ms",
  "> Strategy updated: Thompson Sampling",
  "> Adaptive weight adjusted: graph +0.05",
  "> --------- MEMORY_CYCLE_COMPLETE ---------",
]

export function TerminalCard() {
  const [lines, setLines] = useState<string[]>([])
  const [currentLine, setCurrentLine] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentLine((prev) => {
        const next = prev + 1
        if (next >= LOG_LINES.length) {
          setLines([])
          return 0
        }
        setLines((l) => [...l.slice(-8), LOG_LINES[next]])
        return next
      })
    }, 600)
    setLines([LOG_LINES[0]])
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b-2 border-foreground px-4 py-2">
        <span className="h-2 w-2 bg-[#0001FC]" />
        <span className="h-2 w-2 bg-foreground" />
        <span className="h-2 w-2 border border-foreground" />
        <span className="ml-auto text-[10px] tracking-widest text-muted-foreground uppercase">
          memory.log
        </span>
      </div>
      <div className="flex-1 bg-foreground p-4 overflow-hidden">
        <div className="flex flex-col gap-1">
          {lines.map((line, i) => (
            <span
              key={`${currentLine}-${i}`}
              className="text-xs text-background font-mono block"
              style={{ opacity: i === lines.length - 1 ? 1 : 0.6 }}
            >
              {line}
            </span>
          ))}
          <span className="text-xs text-[#0001FC] font-mono animate-blink">{"_"}</span>
        </div>
      </div>
    </div>
  )
}
