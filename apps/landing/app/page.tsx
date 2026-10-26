import { Header } from "@/components/header"
import { Hero } from "@/components/hero"
import { TestimonialsSection } from "@/components/testimonials-section"
import { HowItWorksSection } from "@/components/how-it-works-section"
import { FAQSection } from "@/components/faq-section"
import { Footer } from "@/components/footer"
import { FadeIn } from "@/components/fade-in"

export default function Page() {
  return (
    <main className="min-h-screen bg-background">
      <div className="mx-8 md:mx-16 lg:mx-24 xl:mx-32 border-x border-white/20">
        <Header />
        <div className="h-px bg-white/20 w-full" />
        <Hero />
        <div className="h-px bg-white/20 w-full" />
        <FadeIn>
          <TestimonialsSection />
        </FadeIn>
        <div className="h-px bg-white/20 w-full" />
        <FadeIn>
          <HowItWorksSection />
        </FadeIn>
        <div className="h-px bg-white/20 w-full" />
        <FadeIn>
          <FAQSection />
        </FadeIn>
        <div className="h-px bg-white/20 w-full" />
        <Footer />
      </div>
    </main>
  )
}
