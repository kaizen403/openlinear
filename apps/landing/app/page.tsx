import { Header } from "@/components/header"
import { Hero } from "@/components/hero"
import { HowItWorksSection } from "@/components/how-it-works-section"
import { FeaturesSection } from "@/components/features-section"
import { UseCasesSection } from "@/components/use-cases-section"
import { IntegrationsSection } from "@/components/integrations-section"
import { PerformanceSection } from "@/components/performance-section"
import { PricingSection } from "@/components/pricing-section"
import { FAQSection } from "@/components/faq-section"
import { FinalCTASection } from "@/components/final-cta-section"
import { Footer } from "@/components/footer"

export default function Page() {
  return (
    <main className="bg-[#0a0f1a]">
      <Header />
      <Hero />
      <HowItWorksSection />
      <FeaturesSection />
      <UseCasesSection />
      <IntegrationsSection />
      <PerformanceSection />
      <PricingSection />
      <FAQSection />
      <FinalCTASection />
      <Footer />
    </main>
  )
}
