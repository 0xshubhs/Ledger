"use client"

import { motion } from "framer-motion"

const ease = [0.22, 1, 0.36, 1] as const

const STEPS = [
  {
    num: "01",
    title: "Connect & Deposit",
    desc: "Install the SDK in one line. Pass your API key. Every agent call automatically routes through the track3 memory layer — zero config required.",
    blue: true,
  },
  {
    num: "02",
    title: "Write Memories",
    desc: "On every agent interaction, track3 extracts entities, detects emotion, assigns temporal markers, and writes structured nodes + edges to the graph.",
    blue: false,
  },
  {
    num: "03",
    title: "Retrieve Intelligently",
    desc: "On recall, all 5 channels fire in parallel — semantic, graph, temporal, emotional, keyword — fused via RRF. Best result, always, under 200ms.",
    blue: true,
  },
  {
    num: "04",
    title: "Adapt & Improve",
    desc: "Thompson Sampling tracks which retrieval strategy wins per agent. Weights update automatically. Your agent gets smarter with every interaction.",
    blue: false,
  },
]

const STEP_STYLES = [
  { bg: "#0001FC", numColor: "rgba(255,255,255,0.1)", titleColor: "#ffffff", descColor: "rgba(255,255,255,0.62)" },
  { bg: "#ffffff",  numColor: "rgba(0,1,252,0.08)",    titleColor: "#0a0a0a",  descColor: "#666666" },
  { bg: "#0001FC", numColor: "rgba(255,255,255,0.1)", titleColor: "#ffffff", descColor: "rgba(255,255,255,0.62)" },
  { bg: "#ffffff",  numColor: "rgba(0,1,252,0.08)",    titleColor: "#0a0a0a",  descColor: "#666666" },
]

export function HowItWorks() {
  return (
    <section className="w-full px-6 py-20 lg:px-12">
      {/* Section label */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease }}
        className="flex items-center gap-4 mb-10"
      >
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">
          {"// SECTION: HOW_IT_WORKS"}
        </span>
        <div className="flex-1 border-t border-border" />
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">003</span>
      </motion.div>

      {/* Headline */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, ease }}
        className="mb-12"
      >
        <h2 className="text-3xl lg:text-5xl font-mono font-black tracking-tight uppercase leading-tight">
          Four steps.<br />
          <span className="text-[#0001FC]">Zero overhead.</span>
        </h2>
      </motion.div>

      {/* Steps grid — alternating blue / white */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 border-2 border-foreground">
        {STEPS.map((step, i) => {
          const s = STEP_STYLES[i]
          return (
            <motion.div
              key={step.num}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.1, duration: 0.5, ease }}
              className={`flex flex-col p-8 lg:p-10 min-h-[280px]
                ${i < 3 ? "border-b-2 lg:border-b-0 lg:border-r-2" : ""}
                border-foreground`}
              style={{ background: s.bg }}
            >
              <div
                className="font-mono font-black leading-none mb-8"
                style={{ fontSize: "clamp(48px,6vw,72px)", color: s.numColor }}
              >
                {step.num}
              </div>
              <h3
                className="font-mono font-black uppercase tracking-tight mb-3"
                style={{ fontSize: "clamp(13px,1.2vw,16px)", color: s.titleColor }}
              >
                {step.title}
              </h3>
              <p className="font-mono leading-relaxed" style={{ fontSize: 13, color: s.descColor }}>
                {step.desc}
              </p>
            </motion.div>
          )
        })}
      </div>
    </section>
  )
}
