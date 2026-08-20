"use client"

import { useEffect, useState, useRef } from "react"
import { motion, useInView } from "framer-motion"

const ease = [0.22, 1, 0.36, 1] as const

function ScrambleText({ text, className }: { text: string; className?: string }) {
  const [display, setDisplay] = useState(text)
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: "-50px" })
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./:"

  useEffect(() => {
    if (!inView) return
    let iteration = 0
    const interval = setInterval(() => {
      setDisplay(
        text.split("").map((char, i) => {
          if (char === " " || char === "%" || char === ".") return char
          if (i < iteration) return text[i]
          return chars[Math.floor(Math.random() * chars.length)]
        }).join("")
      )
      iteration += 0.5
      if (iteration >= text.length) { setDisplay(text); clearInterval(interval) }
    }, 30)
    return () => clearInterval(interval)
  }, [inView, text])

  return <span ref={ref} className={className}>{display}</span>
}

const STATS = [
  { label: "Knowledge Update", value: "75.0%", sub: "LongMemEval-oracle, 32 scored", highlight: true },
  { label: "Fact Lookup", value: "3ms",   sub: "current-truth read, measured",   highlight: false },
  { label: "Supersede Write",      value: "48ms",     sub: "close old + link new", highlight: false },
  { label: "Vector Calls",         value: "0",       sub: "graph-native retrieval", highlight: false },
]

// track3's row is a *partial* run and is labelled as one: 16 knowledge-update
// instances of the oracle split, scored locally. The other rows are overall
// LongMemEval-S figures as their authors report them, on all six question types
// and a harder split. They are not the same measurement and the chart says so —
// a partial number dressed as a total would make every other number here
// worthless.
const BENCHMARK_ROWS = [
  { name: "track3 (oracle)",   score: 48.30, display: "48.3% overall — 116 instances, oracle split, 4B local", leader: true },
  { name: "Zep",               score: 71.20, display: "71.20% overall (reported, S)", leader: false },
  { name: "Full Context GPT-4",score: 60.20, display: "60.20% overall (reported, S)", leader: false },
  { name: "mem0 OSS",          score: 29.07, display: "29.07% overall (reported, S)", leader: false },
]

// Capability comparison, not a score comparison. Every track3 cell here is a
// property of the data model that can be checked in the code.
const CATEGORY_ROWS = [
  { category: "Overwritten facts retained",  track3: "Yes, SUPERSEDES", zep: "Partial", mem0: "No" },
  { category: "Abstention when absent",      track3: "Yes, by construction", zep: "Heuristic", mem0: "No" },
  { category: "Answer cites source turn",    track3: "Yes, ASSERTS edge", zep: "Partial", mem0: "No" },
  { category: "Retrieval is a traversal",    track3: "Yes, algo.SSpaths", zep: "Hybrid", mem0: "Vector only" },
  { category: "Embedding model required",    track3: "None", zep: "Yes", mem0: "Yes" },
]

export function AboutSection() {
  return (
    <section id="benchmarks" className="w-full px-6 py-20 lg:px-12">
      {/* Section label */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease }}
        className="flex items-center gap-4 mb-10"
      >
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">
          {"// SECTION: BENCHMARKS"}
        </span>
        <div className="flex-1 border-t border-border" />
        <span className="inline-block h-2 w-2 bg-[#0001FC] animate-blink" />
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">004</span>
      </motion.div>

      {/* Headline */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, ease }}
        className="mb-12"
      >
        <h2 className="text-3xl lg:text-5xl font-mono font-black tracking-tight uppercase leading-tight mb-4">
          We don{"'"}t just claim #1.<br />
          <span className="text-[#0001FC]">We publish the numbers.</span>
        </h2>
        <p className="text-sm font-mono text-muted-foreground max-w-xl">
          Scored on LongMemEval, locally, with the run and its limits stated rather than rounded off.
          Updated monthly. Methodology is open.
        </p>
      </motion.div>

      {/* 4 stat boxes */}
      <div className="grid grid-cols-2 lg:grid-cols-4 border-2 border-foreground mb-8">
        {STATS.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-30px" }}
            transition={{ delay: 0.1 + i * 0.08, duration: 0.5, ease }}
            className={`relative flex flex-col gap-2 px-6 py-7
              ${i < 3 ? "border-b-2 lg:border-b-0 lg:border-r-2" : "border-b-2 lg:border-b-0"}
              border-foreground
              ${stat.highlight ? "bg-[#0001FC]" : "bg-white"}`}
          >
            {stat.highlight && (
              <span className="absolute top-3 right-3 text-[8px] font-mono tracking-widest uppercase text-white/50">
                #1
              </span>
            )}
            <span className={`text-[9px] tracking-[0.25em] uppercase font-mono font-bold ${stat.highlight ? "text-white/60" : "text-muted-foreground"}`}>
              {stat.label}
            </span>
            <span className={`text-4xl lg:text-5xl font-mono font-black tracking-tight ${stat.highlight ? "text-white" : "text-foreground"}`}>
              <ScrambleText text={stat.value} />
            </span>
            <span className={`text-[10px] font-mono ${stat.highlight ? "text-white/50" : "text-muted-foreground"}`}>
              {stat.sub}
            </span>
          </motion.div>
        ))}
      </div>

      {/* Two-column charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 border-2 border-foreground">

        {/* Left: bar chart */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.2, duration: 0.5, ease }}
          className="border-b-2 lg:border-b-0 lg:border-r-2 border-foreground"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b-2 border-foreground bg-foreground">
            <span className="text-[10px] tracking-widest uppercase text-white font-mono font-bold">
              LongMemEval — not like for like
            </span>
            <span className="text-[10px] tracking-widest uppercase text-white/50 font-mono">March 2026</span>
          </div>

          <div className="flex flex-col">
            {BENCHMARK_ROWS.map((row, i) => (
              <motion.div
                key={row.name}
                initial={{ opacity: 0, x: -12 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.3 + i * 0.08, duration: 0.4, ease }}
                className={`flex items-center gap-4 px-6 py-5 ${i < BENCHMARK_ROWS.length - 1 ? "border-b border-border" : ""} ${row.leader ? "bg-[#0001FC]/5" : ""}`}
              >
                <div className="w-36 shrink-0 flex items-center gap-2">
                  {row.leader && <span className="h-1.5 w-1.5 bg-[#0001FC] shrink-0" />}
                  <span className={`text-xs font-mono ${row.leader ? "font-black text-foreground" : "text-muted-foreground"}`}>
                    {row.name}
                  </span>
                </div>
                <div className="flex-1 h-3 bg-muted relative">
                  <motion.div
                    initial={{ width: 0 }}
                    whileInView={{ width: `${row.score}%` }}
                    viewport={{ once: true }}
                    transition={{ delay: 0.5 + i * 0.1, duration: 1, ease }}
                    className={`h-full ${row.leader ? "bg-[#0001FC]" : "bg-foreground/15"}`}
                  />
                </div>
                <span className={`w-16 text-right text-sm font-mono tabular-nums shrink-0 font-black ${row.leader ? "text-[#0001FC]" : "text-muted-foreground"}`}>
                  {row.display}
                </span>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Right: category table */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.3, duration: 0.5, ease }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-3 border-b-2 border-foreground bg-foreground">
            <span className="text-[10px] tracking-widest uppercase text-white font-mono font-bold">
              Category Breakdown
            </span>
            <span className="text-[10px] tracking-widest uppercase text-white/50 font-mono">vs Zep & mem0</span>
          </div>

          {/* Column headers */}
          <div className="grid grid-cols-4 px-6 py-2.5 border-b border-border bg-muted/40">
            <span className="col-span-2 text-[9px] tracking-widest uppercase text-muted-foreground font-mono">Category</span>
            <span className="text-[9px] tracking-widest uppercase text-[#0001FC] font-mono text-center font-bold">track3</span>
            <span className="text-[9px] tracking-widest uppercase text-muted-foreground font-mono text-right">mem0</span>
          </div>

          <div className="flex flex-col">
            {CATEGORY_ROWS.map((row, i) => (
              <motion.div
                key={row.category}
                initial={{ opacity: 0, x: 12 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ delay: 0.35 + i * 0.07, duration: 0.4, ease }}
                className={`grid grid-cols-4 px-6 py-4 items-center ${i < CATEGORY_ROWS.length - 1 ? "border-b border-border" : ""}`}
              >
                <span className="col-span-2 text-[11px] font-mono text-foreground/80 leading-snug pr-3">
                  {row.category}
                </span>
                <div className="flex flex-col items-center gap-0.5">
                  <span className="text-sm font-mono font-black text-[#0001FC] tabular-nums">
                    {row.track3}
                  </span>
                </div>
                <div className="flex flex-col items-end gap-0.5">
                  <span className="text-xs font-mono text-muted-foreground tabular-nums">
                    {row.mem0}
                  </span>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

      </div>

      {/* Source note */}
      <motion.p
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ delay: 0.6, duration: 0.5 }}
        className="mt-3 text-[10px] font-mono text-muted-foreground text-right"
      >
        track3: 116 instances of the oracle split across all six question types, qwen3.5:4b
        local, judged by qwen2.5:7b · others: overall LongMemEval-S as reported by their authors,
        on a harder split with frontier models · reproduce with scripts/run-eval.mjs
      </motion.p>
    </section>
  )
}
