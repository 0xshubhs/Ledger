"use client"

import { TerminalCard } from "@/components/bento/terminal-card"
import { DitherCard } from "@/components/bento/dither-card"
import { MetricsCard } from "@/components/bento/metrics-card"
import { StatusCard } from "@/components/bento/status-card"
import { motion } from "framer-motion"
import { Brain, GitBranch, Zap, Shield, Globe, Layers } from "lucide-react"

const ease = [0.22, 1, 0.36, 1] as const

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({
    opacity: 1, y: 0,
    transition: { delay: i * 0.1, duration: 0.6, ease },
  }),
}

const FEATURES = [
  {
    icon: Brain,
    title: "Graph-Native Memory",
    desc: "Store memories as a knowledge graph with entities, relationships, and temporal edges — not flat embeddings.",
  },
  {
    icon: GitBranch,
    title: "Temporal Versioning",
    desc: "A revised fact never overwrites the old one. The old fact is closed with valid_to and linked by SUPERSEDES, so history stays queryable.",
  },
  {
    icon: Zap,
    title: "Honest Abstention",
    desc: "A Cypher MATCH that returns zero rows ends the request. There is no nearest neighbour to fall back on, so \"not in memory\" is reachable.",
  },
  {
    icon: Shield,
    title: "BYOK Security",
    desc: "Bring your own keys. Data never leaves your infra. Full tenant isolation with SOC 2 in progress.",
  },
  {
    icon: Globe,
    title: "Any Framework",
    desc: "One API works with LangChain, CrewAI, OpenAI, Anthropic, Vercel AI SDK, and plain HTTP.",
  },
  {
    icon: Layers,
    title: "Auditable Answers",
    desc: "Every fact keeps an ASSERTS edge to the exact turn that stated it, so an answer can quote its own source instead of asserting it.",
  },
]

export function FeatureGrid() {
  return (
    <section id="features" className="w-full px-6 py-20 lg:px-12">
      {/* Section label */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease }}
        className="flex items-center gap-4 mb-10"
      >
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">
          {"// SECTION: MEMORY_STACK"}
        </span>
        <div className="flex-1 border-t border-border" />
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">002</span>
      </motion.div>

      {/* Headline */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, ease }}
        className="mb-12 max-w-2xl"
      >
        <h2 className="text-3xl lg:text-5xl font-mono font-black tracking-tight uppercase leading-tight mb-4">
          Memory infrastructure<br />
          <span className="text-[#0001FC]">built for production.</span>
        </h2>
        <p className="text-sm font-mono text-muted-foreground leading-relaxed">
          Not a wrapper around vector search. A full memory operating system with
          graph storage, temporal versioning, and honest abstention baked in.
        </p>
      </motion.div>

      {/* Bento grid */}
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        className="grid grid-cols-1 md:grid-cols-2 border-2 border-foreground mb-6"
      >
        <motion.div custom={0} variants={cardVariants} className="border-b-2 md:border-b-0 md:border-r-2 border-foreground min-h-[320px]">
          <TerminalCard />
        </motion.div>
        <motion.div custom={1} variants={cardVariants} className="border-b-2 md:border-b-0 border-foreground min-h-[320px]">
          <DitherCard />
        </motion.div>
        <motion.div custom={2} variants={cardVariants} className="border-t-2 md:border-r-2 border-foreground min-h-[320px]">
          <MetricsCard />
        </motion.div>
        <motion.div custom={3} variants={cardVariants} className="border-t-2 border-foreground min-h-[320px]">
          <StatusCard />
        </motion.div>
      </motion.div>

      {/* Feature cards 6-grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 border-2 border-foreground mt-12">
        {FEATURES.map((feat, i) => (
          <motion.div
            key={feat.title}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.08, duration: 0.5, ease }}
            className={`flex flex-col gap-3 p-6
              ${i % 3 !== 2 ? "lg:border-r-2" : ""}
              ${i % 2 !== 1 ? "sm:border-r-2 lg:border-r-0" : ""}
              ${i < 3 ? "border-b-2" : ""}
              border-foreground group hover:bg-[#0001FC] transition-colors duration-300`}
          >
            <feat.icon size={20} strokeWidth={1.5} className="text-[#0001FC] group-hover:text-white transition-colors" />
            <h3 className="text-sm font-mono font-black uppercase tracking-wide text-foreground group-hover:text-white transition-colors">
              {feat.title}
            </h3>
            <p className="text-xs font-mono text-muted-foreground leading-relaxed group-hover:text-white/70 transition-colors">
              {feat.desc}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  )
}
