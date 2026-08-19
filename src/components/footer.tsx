"use client"

import { motion } from "framer-motion"
import { Brain, Code2, ExternalLink } from "lucide-react"
import Link from "next/link"

const ease = [0.22, 1, 0.36, 1] as const

// Anchors on this page and files in the repo. "Changelog", "SDKs" and "MCP
// Integration" are gone rather than pointed somewhere plausible — none of them
// exist, and a link to a page that does not is worse than no link at all.
interface FooterLink {
  label: string
  href: string
  /** Repo files open in a new tab; page anchors do not. */
  external?: boolean
}

const PRODUCT_LINKS: FooterLink[] = [
  { label: "Features", href: "#features" },
  { label: "Benchmarks", href: "#benchmarks" },
  { label: "Pricing", href: "#pricing" },
  { label: "Live console", href: "#console" },
]
const DEV_LINKS: FooterLink[] = [
  { label: "README", href: "https://github.com/0xshubhs/hydradb1#readme", external: true },
  { label: "HydraDB notes", href: "https://github.com/0xshubhs/hydradb1/blob/main/HYDRADB-NOTES.md", external: true },
  { label: "Status", href: "https://github.com/0xshubhs/hydradb1/blob/main/completion.md", external: true },
  { label: "Plan", href: "https://github.com/0xshubhs/hydradb1/blob/main/plan.md", external: true },
]

export function Footer() {
  return (
    <motion.footer
      initial={{ opacity: 0 }}
      whileInView={{ opacity: 1 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.6, ease }}
      className="w-full"
      style={{ background: "#000000" }}
    >
      {/* Main row — brand + description + links all in one line */}
      <div className="px-6 py-10 lg:px-20">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-8">

          {/* Left: logo + description + bullets */}
          <div className="flex flex-col gap-4 max-w-xs">
            <div className="flex items-center gap-2.5">
              <Brain size={18} strokeWidth={2} className="text-[#0001FC]" />
              <span className="text-sm font-mono tracking-[0.25em] uppercase font-black text-white">track3</span>
            </div>
            <p className="text-xs font-mono text-white/50 leading-relaxed">
              The memory layer AI agents actually deserve.
              Graph-native, temporally versioned, abstention-first —
              one API to make your agents remember everything.
            </p>
            <div className="flex flex-col gap-1.5">
              {[
                "Temporal fact graph on HydraDB",
                "Free tier — No credit card required",
                "BYOK — Your keys, your data",
              ].map((item) => (
                <div key={item} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 bg-[#0001FC] shrink-0" />
                  <span className="text-[9px] font-mono tracking-widest uppercase text-white/40">{item}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 mt-1">
              {[
                { icon: Code2, label: "GitHub", href: "https://github.com/0xshubhs/hydradb1" },
                { icon: ExternalLink, label: "Docs", href: "https://github.com/0xshubhs/hydradb1#readme" },
              ].map(({ icon: Icon, label, href }) => (
                <motion.a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.95 }}
                  aria-label={label}
                  className="w-8 h-8 flex items-center justify-center border border-white/15 text-white/40 hover:text-white hover:border-white/40 transition-colors"
                >
                  <Icon size={13} strokeWidth={1.5} />
                </motion.a>
              ))}
            </div>
          </div>

          {/* Right: two vertical columns side by side */}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: 0.1, duration: 0.4, ease }}
            className="flex gap-12"
          >
            {/* Product column */}
            <div className="flex flex-col gap-3">
              <span className="text-[9px] font-mono tracking-[0.3em] uppercase text-white/30 mb-1">Product</span>
              {PRODUCT_LINKS.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                  className="text-xs font-mono text-white/50 hover:text-white transition-colors"
                >
                  {link.label}
                </Link>
              ))}
            </div>
            {/* Developers column */}
            <div className="flex flex-col gap-3">
              <span className="text-[9px] font-mono tracking-[0.3em] uppercase text-white/30 mb-1">Developers</span>
              {DEV_LINKS.map((link) => (
                <Link
                  key={link.label}
                  href={link.href}
                  {...(link.external ? { target: "_blank", rel: "noreferrer" } : {})}
                  className="text-xs font-mono text-white/50 hover:text-white transition-colors"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </motion.div>

        </div>
      </div>

    </motion.footer>
  )
}
