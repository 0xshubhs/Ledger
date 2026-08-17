import { Navbar } from "@/components/navbar"
import { HeroSection } from "@/components/hero-section"
import { FeatureGrid } from "@/components/feature-grid"
import { HowItWorks } from "@/components/how-it-works"
import { AboutSection } from "@/components/about-section"
import { PricingSection } from "@/components/pricing-section"
import { CtaSection } from "@/components/cta-section"
import { Footer } from "@/components/footer"

export default function Page() {
  return (
    <div className="min-h-screen bg-white text-foreground overflow-x-hidden">
      <Navbar />
      <main className="font-mono">
        <HeroSection />

        {/* Marquee */}
        <div className="border-y-2 border-[#0001FC] bg-[#0001FC] text-white py-3 flex overflow-hidden">
          <div className="flex animate-marquee whitespace-nowrap gap-16 font-bold uppercase tracking-[0.35em] text-xs">
            {[
              "LongMemEval 90.79%", "↗", "Graph-Native Storage", "↗",
              "5-Channel Retrieval Fusion", "↗", "Temporal Versioning", "↗",
              "Emotional Intelligence", "↗", "Thompson Sampling Adaptive", "↗",
              "LongMemEval 90.79%", "↗", "Graph-Native Storage", "↗",
              "5-Channel Retrieval Fusion", "↗", "Temporal Versioning", "↗",
              "Emotional Intelligence", "↗", "Thompson Sampling Adaptive", "↗",
            ].map((t, i) => <span key={i}>{t}</span>)}
          </div>
        </div>

        <FeatureGrid />
        <HowItWorks />
        <AboutSection />
        <PricingSection />
        <CtaSection />
      </main>
      <Footer />
    </div>
  )
}
