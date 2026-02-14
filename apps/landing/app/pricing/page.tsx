"use client"

import { useState } from "react"
import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ArrowRight, Check, ChevronDown } from "lucide-react"

const plans = [
  {
    name: "Free",
    price: "$0",
    period: "/month",
    description: "For individual developers exploring AI execution.",
    cta: { label: "Get Started", href: "#", style: "secondary" as const },
    features: [
      "Single project",
      "Basic execution",
      "OpenCode agent",
      "Community support",
      "25 executions/month",
    ],
  },
  {
    name: "Pro",
    price: "$20",
    period: "/month",
    description: "For developers who need more power and flexibility.",
    popular: true,
    cta: { label: "Upgrade to Pro", href: "#", style: "primary" as const },
    features: [
      "Multiple projects",
      "Batch execution (parallel + queue)",
      "Configurable concurrency limits",
      "Advanced agent settings",
      "Priority support",
      "Unlimited executions",
      "All premium agents",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    period: "",
    description: "For teams that need full control and dedicated support.",
    cta: { label: "Contact Sales", href: "/contact", style: "secondary" as const },
    features: [
      "Everything in Pro",
      "Self-hosted deployment",
      "SSO & access controls",
      "Dedicated account manager",
      "Custom agent configuration",
      "SLA guarantees",
      "Audit logging & compliance",
      "Onboarding & training",
    ],
  },
]

const faqs = [
  {
    q: "Can I use OpenLinear for free?",
    a: "Yes. The free plan includes a single project with basic execution capabilities and 25 executions per month. No credit card required.",
  },
  {
    q: "What happens when I reach my execution limit?",
    a: "On the free plan, you'll need to wait until the next month or upgrade to Pro for unlimited executions. Pro and Enterprise plans have no execution limits.",
  },
  {
    q: "Does OpenLinear send my code to the cloud?",
    a: "No. OpenLinear runs entirely on your machine. Your code never leaves your network unless you explicitly push to GitHub.",
  },
  {
    q: "Can I switch plans at any time?",
    a: "Yes. You can upgrade or downgrade at any time. When upgrading, you get immediate access to new features. When downgrading, changes take effect at the next billing cycle.",
  },
  {
    q: "What AI agents are supported?",
    a: "Currently OpenLinear supports OpenCode as the primary agent. Support for Claude Code, Codex, and Aider is on our roadmap.",
  },
]

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="border-b border-border/20">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 text-left group"
      >
        <span className="text-[0.9375rem] font-medium text-foreground/85 tracking-[-0.01em] pr-8">
          {q}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground/40 shrink-0 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <div
        className={`overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${open ? "max-h-40 pb-5" : "max-h-0"}`}
      >
        <p className="text-[0.875rem] text-muted-foreground/55 leading-[1.7] tracking-[-0.01em]">
          {a}
        </p>
      </div>
    </div>
  )
}

export default function PricingPage() {
  return (
    <main>
      <Header />

      {/* ── Hero ─────────────────────────────────── */}
      <section className="relative min-h-[85svh] flex items-center overflow-hidden">
        <div className="absolute inset-0 bg-[#161820]" />
        <div className="absolute top-[-15%] right-[25%] w-[700px] h-[500px] rounded-full bg-[hsl(45_30%_30%/0.12)] blur-[180px] pointer-events-none" />
        <div className="absolute bottom-[-10%] left-[20%] w-[500px] h-[400px] rounded-full bg-[hsl(220_50%_25%/0.15)] blur-[160px] pointer-events-none" />
        <div className="absolute inset-0 opacity-[0.02]" style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: '80px 80px'
        }} />
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

        <div className="relative mx-auto max-w-none px-[100px] w-full text-center py-40">
          <span className="hero-reveal-1 inline-block text-[0.75rem] font-semibold text-[#EDE8D0]/40 tracking-[0.2em] uppercase mb-8">
            Pricing
          </span>
          <h1 className="hero-reveal-2 font-display text-[2.75rem] md:text-[3.75rem] lg:text-[4.5rem] font-bold tracking-[-0.05em] text-[#EDE8D0] leading-[1.02] max-w-3xl mx-auto">
            Plans and Pricing
          </h1>
          <p className="hero-reveal-3 text-[#EDE8D0]/40 leading-[1.75] text-[1.0625rem] tracking-[-0.01em] max-w-lg mx-auto mt-8">
            Start free. Upgrade when you need more power.
          </p>
        </div>
      </section>

      {/* ── Pricing Cards ────────────────────────── */}
      <section className="relative py-20 md:py-28 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="grid md:grid-cols-3 gap-6 lg:gap-8 max-w-5xl mx-auto">
            {plans.map((plan) => (
              <div
                key={plan.name}
                className={`mock-card rounded-2xl p-8 lg:p-10 flex flex-col relative ${plan.popular
                  ? "ring-1 ring-primary/30"
                  : ""
                  }`}
              >
                {plan.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 inline-flex items-center rounded-full bg-primary px-4 py-1 text-[0.6875rem] font-semibold text-primary-foreground tracking-wide uppercase">
                    Popular
                  </span>
                )}

                <div>
                  <h3 className="text-[0.875rem] font-semibold text-primary/60 tracking-[-0.01em]">
                    {plan.name}
                  </h3>
                  <div className="flex items-baseline mt-3">
                    <span className="font-display text-[2.75rem] font-bold tracking-[-0.04em] text-foreground leading-none">
                      {plan.price}
                    </span>
                    {plan.period && (
                      <span className="text-muted-foreground/40 text-[0.875rem] ml-1.5">
                        {plan.period}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground/45 text-[0.8125rem] mt-3 leading-[1.6]">
                    {plan.description}
                  </p>
                </div>

                <a
                  href={plan.cta.href}
                  className={`inline-flex items-center justify-center gap-2.5 rounded-full px-7 py-3 text-[0.875rem] font-medium w-full mt-8 ${plan.cta.style === "primary"
                    ? "btn-primary bg-primary text-primary-foreground"
                    : "btn-secondary border border-border/50 bg-background text-foreground/80"
                    }`}
                >
                  {plan.cta.label}
                  {plan.cta.style === "primary" && <ArrowRight className="h-3.5 w-3.5" />}
                </a>

                <div className="h-[1px] bg-border/30 my-7" />

                <ul className="flex flex-col gap-3.5 flex-1">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-3 text-[0.8125rem] text-muted-foreground/60 tracking-[-0.01em]">
                      <Check className="h-4 w-4 text-primary/50 shrink-0 mt-0.5" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── FAQ ───────────────────────────────────── */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="max-w-2xl mx-auto">
            <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground text-center mb-12">
              Frequently Asked Questions
            </h2>
            <div>
              {faqs.map((faq) => (
                <FAQItem key={faq.q} q={faq.q} a={faq.a} />
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Custom CTA ───────────────────────────── */}
      <section className="relative py-20 md:py-24 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px] text-center">
          <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">
            Need something custom?
          </h3>
          <p className="text-muted-foreground/55 text-[0.9375rem] tracking-[-0.01em]">
            Reach out at{" "}
            <a
              href="mailto:hello@openlinear.dev"
              className="text-primary/80 hover:text-primary transition-colors duration-250"
            >
              hello@openlinear.dev
            </a>{" "}
            or{" "}
            <a
              href="/contact"
              className="text-primary/80 hover:text-primary transition-colors duration-250"
            >
              contact us directly
            </a>
            .
          </p>
        </div>
      </section>

      <Footer />
    </main>
  )
}
