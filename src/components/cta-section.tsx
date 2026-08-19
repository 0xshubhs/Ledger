"use client"

import { motion } from "framer-motion"
import { ArrowRight } from "lucide-react"
import Link from "next/link"

const ease = [0.22, 1, 0.36, 1] as const

export function CtaSection() {
  return (
    <section
      className="w-full px-6 py-24 lg:px-12"
      style={{ background: "#0001FC" }}
    >
      <div className="max-w-4xl mx-auto">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, ease }}
          className="text-center"
        >
          <div className="text-[10px] font-mono tracking-[0.3em] uppercase text-white/40 mb-6">
            Get started today
          </div>
          <h2 className="text-4xl lg:text-6xl font-mono font-black uppercase tracking-tight text-white leading-[0.95] mb-6">
            Your agents.<br />
            <span className="text-white/40">Never forget.</span>
          </h2>
          <p className="text-sm font-mono text-white/60 max-w-lg mx-auto mb-10 leading-relaxed">
            Connect your first agent in under two minutes. Free tier, no credit card.
            The memory layer your agents actually deserve.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-16">
            <Link
              href="#console"
              className="group flex items-center gap-0 bg-white text-[#0001FC] text-sm font-mono font-black tracking-widest uppercase hover:opacity-90 transition-opacity"
            >
              <span className="flex items-center justify-center w-12 h-12 bg-foreground">
                <motion.span
                  className="inline-flex"
                  whileHover={{ x: 3 }}
                  transition={{ type: "spring", stiffness: 400, damping: 20 }}
                >
                  <ArrowRight size={18} strokeWidth={3} className="text-white" />
                </motion.span>
              </span>
              <span className="px-8 py-3">Get Free API Key</span>
            </Link>
            <Link
              href="https://github.com/0xshubhs/hydradb1#readme"
            target="_blank"
            rel="noreferrer"
              className="text-[11px] font-mono tracking-widest uppercase text-white/50 hover:text-white transition-colors border border-white/20 px-8 py-3.5"
            >
              Read the Docs
            </Link>
          </div>

          {/* Bottom stats row */}
          <div className="grid grid-cols-3 border border-white/20 max-w-xl mx-auto">
            {[
              { val: "Free", label: "To start" },
              { val: "<2 min", label: "To integrate" },
              { val: "Zero", label: "Cards required" },
            ].map((item, i) => (
              <div
                key={item.label}
                className={`flex flex-col items-center py-4 px-3 ${i < 2 ? "border-r border-white/20" : ""}`}
              >
                <span className="text-lg font-mono font-black text-white">{item.val}</span>
                <span className="text-[9px] font-mono tracking-widest uppercase text-white/40">{item.label}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  )
}
