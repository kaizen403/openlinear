import { Header } from "@/components/header"
import { Hero } from "@/components/hero"
import { TextHighlighter } from "@/components/text-highlighter"
import { ProductSuite } from "@/components/product-suite"
import { FeatureSections } from "@/components/feature-sections"
import { VisionSection } from "@/components/vision-section"
import { CTASection } from "@/components/cta-section"
import { Footer } from "@/components/footer"

export default function Page() {
  return (
    <main>
      <Header />
      <Hero />
      <TextHighlighter />
      <ProductSuite />
      <FeatureSections />
      <VisionSection />
      <CTASection />
      <Footer />
    </main>
  )
}
