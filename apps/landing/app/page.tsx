import { Header } from "@/components/header"
import { Hero } from "@/components/hero"
import { FeaturesSection } from "@/components/features-section"
import { IntegrationsSection } from "@/components/integrations-section"
import { PerformanceSection } from "@/components/performance-section"
import { PricingSection } from "@/components/pricing-section"
import { Footer } from "@/components/footer"

export default function Page() {
  return (
    <main className="bg-[#0a0f1a]">
      <Header />
      <Hero />
      <FeaturesSection />
      <IntegrationsSection />
      <PerformanceSection />
      <PricingSection />
      <Footer />
    </main>
  )
}
