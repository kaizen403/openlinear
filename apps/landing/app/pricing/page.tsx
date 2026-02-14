import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ArrowRight } from "lucide-react"

export default function PricingPage() {
  return (
    <main>
      <Header />

      <section className="relative bg-background pt-40 pb-20">
        <div className="mx-auto max-w-none px-[100px]">
          <span className="text-[0.75rem] font-semibold text-primary/60 mb-5 tracking-[-0.01em] block">
            Pricing
          </span>
          <h1 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-foreground text-balance leading-[1.04] mt-5">
            Simple pricing.
          </h1>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-6">
            Start free. Upgrade when you need more.
          </p>
        </div>
      </section>

      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="grid md:grid-cols-2 gap-8 lg:gap-12 max-w-3xl mx-auto">
            <div className="mock-card rounded-2xl p-8 lg:p-10">
              <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[-0.01em] mb-2 block">
                Free
              </span>
              <div className="flex items-baseline">
                <span className="font-display text-[2.5rem] font-bold tracking-[-0.04em] text-foreground">
                  $0
                </span>
                <span className="text-muted-foreground/40 text-[0.875rem] ml-1">
                  /month
                </span>
              </div>
              <div className="h-[1px] bg-border/40 my-6" />
              <ul className="flex flex-col gap-4">
                {[
                  "Single project",
                  "Basic execution",
                  "OpenCode agent",
                  "Community support",
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                    <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                href="#"
                className="btn-secondary inline-flex items-center gap-2 rounded-full border border-border/50 bg-background px-7 py-3 text-[0.875rem] font-medium text-foreground/80 mt-8 w-full justify-center"
              >
                Get Started
              </a>
            </div>

            <div className="mock-card rounded-2xl p-8 lg:p-10">
              <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[-0.01em] mb-2 block">
                Pro
              </span>
              <div className="flex items-baseline">
                <span className="font-display text-[2.5rem] font-bold tracking-[-0.04em] text-foreground">
                  $20
                </span>
                <span className="text-muted-foreground/40 text-[0.875rem] ml-1">
                  /month
                </span>
              </div>
              <div className="h-[1px] bg-border/40 my-6" />
              <ul className="flex flex-col gap-4">
                {[
                  "Multiple projects",
                  "Batch execution",
                  "Advanced settings",
                  "Configurable limits",
                  "Priority support",
                ].map((feature) => (
                  <li key={feature} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                    <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                href="#"
                className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-7 py-3 text-[0.875rem] font-medium text-primary-foreground mt-8 w-full justify-center"
              >
                Upgrade to Pro <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="relative py-20 md:py-24 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <p className="text-center text-muted-foreground/65 text-[0.9375rem] tracking-[-0.01em]">
            Need something custom? Contact us at{" "}
            <a
              href="mailto:hello@openlinear.dev"
              className="text-primary/80 hover:text-primary transition-colors duration-250"
            >
              hello@openlinear.dev
            </a>
          </p>
        </div>
      </section>

      <Footer />
    </main>
  )
}
