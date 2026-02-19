import { Check } from "lucide-react"

export function PricingSection() {
  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-[#0a0f1a]" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <span className="inline-block px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 mb-6">
            API Pricing
          </span>
          
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] lg:text-[4rem] font-bold tracking-[-0.02em] text-white leading-[1.1]">
            The most cost-efficient
            <br />
            task execution platform
          </h2>
          
          <p className="mt-6 text-lg text-white/50 max-w-2xl mx-auto">
            Start free, experiment fast, and only pay when your team scales. No hidden fees.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
          <PricingCard
            name="Free"
            price="$0"
            period="/month"
            description="Perfect for getting started with AI task execution."
            features={[
              "100 tasks / month",
              "1 repository",
              "Basic AI model",
              "Email support",
            ]}
            cta="Try for free"
            variant="outline"
          />

          <PricingCard
            name="Pro"
            price="$19"
            period="/month"
            description="Task execution for power users and quick moving teams."
            features={[
              "1,000 tasks / month",
              "10 repositories",
              "Advanced AI models",
              "Priority support",
              "Custom integrations",
            ]}
            cta="Get started with Pro →"
            variant="highlight"
          />

          <PricingCard
            name="Scale"
            price="$399"
            period="/month"
            description="Enterprise-grade execution for large organizations."
            features={[
              "Unlimited tasks",
              "Unlimited repositories",
              "Premium AI models",
              "Dedicated support",
              "Custom integration",
              "SLA guarantee",
            ]}
            cta="Get started with Scale →"
            variant="outline"
          />
        </div>
      </div>
    </section>
  )
}

function PricingCard({
  name,
  price,
  period,
  description,
  features,
  cta,
  variant,
}: {
  name: string
  price: string
  period: string
  description: string
  features: string[]
  cta: string
  variant: "outline" | "highlight"
}) {
  const isHighlight = variant === "highlight"

  return (
    <div
      className={`relative rounded-3xl p-8 ${
        isHighlight
          ? "bg-gradient-to-b from-blue-500/20 to-blue-600/10 border border-blue-500/30"
          : "bg-white/[0.02] border border-white/[0.06]"
      }`}
    >
      <div className="mb-6">
        <span className={`inline-block px-3 py-1 rounded-full text-xs ${isHighlight ? "bg-blue-500/20 text-blue-300" : "bg-white/[0.04] text-white/60"}`}>
          {name}
        </span>
      </div>

      <div className="mb-4">
        <span className="text-5xl font-bold text-white">{price}</span>
        <span className="text-white/40">{period}</span>
      </div>

      <p className="text-white/50 text-sm mb-6">{description}</p>

      <ul className="space-y-3 mb-8">
        {features.map((feature) => (
          <li key={feature} className="flex items-center gap-3 text-sm text-white/70">
            <Check className={`h-4 w-4 ${isHighlight ? "text-blue-400" : "text-white/40"}`} />
            {feature}
          </li>
        ))}
      </ul>

      <button
        type="button"
        className={`w-full py-3 rounded-xl font-medium transition-all ${
          isHighlight
            ? "bg-gradient-to-b from-blue-500 to-blue-600 text-white hover:from-blue-400 hover:to-blue-500"
            : "bg-white/[0.04] border border-white/[0.12] text-white hover:bg-white/[0.08]"
        }`}
      >
        {cta}
      </button>
    </div>
  )
}
