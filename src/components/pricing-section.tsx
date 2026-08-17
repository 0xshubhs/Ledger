"use client"

import { motion } from "framer-motion"
import { Check, ArrowRight } from "lucide-react"
import Link from "next/link"

const ease = [0.22, 1, 0.36, 1] as const

const PLANS = [
  {
    name: "FREE",
    price: "$0",
    period: "/month",
    description: "For developers exploring track3",
    features: [
      "Unlimited API calls",
      "Up to 10k memories",
      "Graph + semantic retrieval",
      "Python & Node.js SDK",
      "Community support",
    ],
    cta: "Start Building",
    highlight: false,
  },
  {
    name: "PRO",
    price: "$25",
    period: "/month",
    description: "For agents scaling in production",
    features: [
      "Everything in Free",
      "Up to 2M memories",
      "Temporal + multi-hop retrieval",
      "Adaptive strategy selection",
      "Memory consolidation",
      "Private Slack channel",
      "SOC 2 reports",
    ],
    cta: "Get Pro",
    highlight: true,
  },
  {
    name: "SCALE",
    price: "$399",
    period: "/month",
    description: "For enterprise-grade deployments",
    features: [
      "Everything in Pro",
      "Unlimited memories",
      "Self-hosting option",
      "BYOC deployment",
      "HIPAA BAA available",
      "Dedicated infrastructure",
      "Uptime SLA",
    ],
    cta: "Talk to Us",
    highlight: false,
  },
]

export function PricingSection() {
  return (
    <section className="w-full px-6 py-20 lg:px-20">
      {/* Section label */}
      <motion.div
        initial={{ opacity: 0, x: -20 }}
        whileInView={{ opacity: 1, x: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease }}
        className="flex items-center gap-4 mb-12"
      >
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">
          {"// SECTION: PRICING"}
        </span>
        <div className="flex-1 border-t border-border" />
        <span className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground font-mono">006</span>
      </motion.div>

      {/* Headline */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, ease }}
        className="mb-12 text-center"
      >
        <h2 className="text-3xl lg:text-4xl font-mono font-black tracking-tight uppercase mb-3">
          Simple Storage Pricing
        </h2>
        <p className="text-sm font-mono text-muted-foreground max-w-md mx-auto">
          No per-seat fees. No API limits. Pay for what your agents actually use.
        </p>
      </motion.div>

      {/* Plans */}
      <div className="grid grid-cols-1 md:grid-cols-3 border-2 border-foreground">
        {PLANS.map((plan, i) => (
          <motion.div
            key={plan.name}
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.1, duration: 0.5, ease }}
            className={`flex flex-col p-6 lg:p-8 ${i < 2 ? "border-b-2 md:border-b-0 md:border-r-2 border-foreground" : ""} ${plan.highlight ? "bg-foreground text-background" : "bg-background"}`}
          >
            {/* Plan header */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-4">
                <span className={`text-[10px] font-mono tracking-[0.3em] uppercase font-black ${plan.highlight ? "text-background/60" : "text-muted-foreground"}`}>
                  {plan.name}
                </span>
                {plan.highlight && (
                  <span className="text-[9px] font-mono tracking-widest uppercase px-2 py-0.5 bg-[#0001FC] text-white">
                    POPULAR
                  </span>
                )}
              </div>
              <div className="flex items-baseline gap-1 mb-2">
                <span className={`text-4xl font-mono font-black ${plan.highlight ? "text-background" : "text-foreground"}`}>
                  {plan.price}
                </span>
                <span className={`text-xs font-mono ${plan.highlight ? "text-background/60" : "text-muted-foreground"}`}>
                  {plan.period}
                </span>
              </div>
              <p className={`text-xs font-mono ${plan.highlight ? "text-background/70" : "text-muted-foreground"}`}>
                {plan.description}
              </p>
            </div>

            {/* Features */}
            <div className="flex flex-col gap-2.5 flex-1 mb-8">
              {plan.features.map((feature) => (
                <div key={feature} className="flex items-start gap-2.5">
                  <Check size={12} className={`mt-0.5 shrink-0 ${plan.highlight ? "text-[#0001FC]" : "text-[#0001FC]"}`} strokeWidth={3} />
                  <span className={`text-xs font-mono ${plan.highlight ? "text-background/80" : "text-foreground/80"}`}>
                    {feature}
                  </span>
                </div>
              ))}
            </div>

            {/* CTA */}
            <Link
              href="/signup"
              className={`group flex items-center justify-between border-2 px-5 py-3 text-[10px] font-mono tracking-widest uppercase font-black transition-opacity hover:opacity-80 ${
                plan.highlight
                  ? "border-background text-background"
                  : "border-foreground text-foreground"
              }`}
            >
              {plan.cta}
              <ArrowRight size={13} strokeWidth={2.5} className="group-hover:translate-x-1 transition-transform" />
            </Link>
          </motion.div>
        ))}
      </div>

      {/* Enterprise callout */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ delay: 0.4, duration: 0.5, ease }}
        className="mt-4 border-2 border-foreground px-6 py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
      >
        <div>
          <span className="text-xs font-mono font-bold uppercase tracking-widest">ENTERPRISE</span>
          <p className="text-[10px] font-mono text-muted-foreground mt-1">
            BYOC · Air-gapped · Custom SLAs · Dedicated infra · Forward-deployed engineer
          </p>
        </div>
        <Link
          href="/enterprise"
          className="flex items-center gap-2 text-[10px] font-mono tracking-widest uppercase text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
        >
          Book a call <ArrowRight size={11} strokeWidth={2} />
        </Link>
      </motion.div>
    </section>
  )
}
