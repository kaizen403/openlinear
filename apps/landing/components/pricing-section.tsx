import { Check } from "lucide-react"

export function PricingSection() {
  return (
    <section className="relative py-24 overflow-hidden bg-[#0a0f1a]">
      <div className="relative mx-auto max-w-[1200px] px-4">
        <div className="text-center mb-16 flex flex-col items-center">
          <div className="inline-block px-3 py-1 rounded-md bg-white/[0.03] border border-white/[0.08] text-[13px] text-white/60 mb-6">
            API Pricing
          </div>
          
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-tight text-white leading-[1.1] max-w-3xl mb-4">
            The most cost-efficient context provider for your AI infrastructure
          </h2>
          
          <p className="text-[17px] text-white/50">
            Start free, experiment fast, and only pay when your memory becomes your moat. No hidden fees.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Free Card */}
          <div className="rounded-[32px] bg-[#0d121c] border border-white/[0.06] p-8 flex flex-col h-full hover:bg-white/[0.04] transition-colors">
            <div className="mb-6">
              <span className="inline-block px-3 py-1 rounded-full text-xs bg-white/[0.05] border border-white/10 text-white/70">
                Free
              </span>
            </div>

            <div className="mb-4">
              <span className="text-[40px] font-bold text-white tracking-tight">$0</span>
              <span className="text-[15px] text-white/40 ml-1">/month</span>
            </div>

            <p className="text-white/50 text-[15px] mb-8 min-h-[48px]">
              Perfect for getting started with memory as a service.
            </p>

            <ul className="space-y-4 mb-8 flex-1">
              <FeatureItem text="1M tokens processed" />
              <FeatureItem text="10K search queries" />
              <FeatureItem text="Email support" />
            </ul>

            <button type="button" className="w-full py-3.5 rounded-[16px] font-medium text-[15px] bg-white/[0.03] border border-white/[0.08] text-white hover:bg-white/[0.08] transition-all">
              Try for free
            </button>
          </div>

          {/* Pro Card (Highlighted) */}
          <div className="rounded-[32px] bg-[#0d121c] border border-white/[0.06] overflow-hidden flex flex-col h-full relative group">
            {/* Top Gradient Block */}
            <div className="bg-gradient-to-br from-blue-500 to-blue-700 p-8 relative overflow-hidden h-[240px]">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,0.2),transparent_50%)]" />
              <div className="relative z-10">
                <div className="mb-6">
                  <span className="inline-block px-3 py-1 rounded-full text-xs bg-white/20 text-white font-medium">
                    Pro
                  </span>
                </div>
                <div className="mb-2">
                  <span className="text-[40px] font-bold text-white tracking-tight">$19</span>
                  <span className="text-[15px] text-white/70 ml-1">/month</span>
                </div>
                <p className="text-white/90 text-[15px]">
                  Memory for power users and quick moving teams.
                </p>
              </div>
            </div>

            <div className="p-8 pt-6 flex-1 flex flex-col">
              <ul className="space-y-4 mb-8 flex-1">
                <FeatureItem text="3M tokens processed" />
                <FeatureItem text="100K search queries" />
                <FeatureItem text="Priority support" />
                <FeatureItem text="Advanced analytics" />
              </ul>

              <button type="button" className="w-full py-3.5 rounded-[16px] font-medium text-[15px] bg-gradient-to-r from-blue-500 to-blue-600 text-white hover:opacity-90 transition-opacity shadow-[0_0_20px_rgba(59,130,246,0.3)]">
                Get started with Pro →
              </button>
            </div>
          </div>

          {/* Scale Card */}
          <div className="rounded-[32px] bg-[#0d121c] border border-white/[0.06] p-8 flex flex-col h-full hover:bg-white/[0.04] transition-colors">
            <div className="mb-6">
              <span className="inline-block px-3 py-1 rounded-full text-xs bg-white/[0.05] border border-white/10 text-white/70">
                Scale
              </span>
            </div>

            <div className="mb-4">
              <span className="text-[40px] font-bold text-white tracking-tight">$399</span>
              <span className="text-[15px] text-white/40 ml-1">/month</span>
            </div>

            <p className="text-white/50 text-[15px] mb-8 min-h-[48px]">
              Enterprise-grade memory for large organisations with dedicated support.
            </p>

            <ul className="space-y-4 mb-8 flex-1">
              <FeatureItem text="80M tokens processed" highlight />
              <FeatureItem text="20M search queries" highlight />
              <FeatureItem text="Dedicated support" />
              <FeatureItem text="Custom Integration" />
              <FeatureItem text="Slack Support Channel" />
            </ul>

            <button type="button" className="w-full py-3.5 rounded-[16px] font-medium text-[15px] bg-white/[0.03] border border-white/[0.08] text-white hover:bg-white/[0.08] transition-all">
              Get started with Scale →
            </button>
          </div>
        </div>

        {/* Overages */}
        <div className="mt-8 rounded-[32px] bg-[#0d121c] border border-white/[0.06] p-8 flex flex-col md:flex-row md:items-center justify-between gap-8">
          <div>
            <h3 className="text-[28px] font-bold text-white tracking-tight mb-1">Overages</h3>
          </div>
          <div className="text-right hidden md:block">
            <p className="text-[11px] text-white/40 uppercase tracking-widest font-semibold mb-1">FOR PRO AND SCALE PAID PLANS</p>
            <p className="text-[11px] text-white/40 uppercase tracking-widest font-semibold">ONLY IF LIMIT IS EXCEEDED</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-8 md:gap-16">
            <div>
              <p className="text-[13px] text-white/60 mb-2 font-medium">Token processing</p>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-bold text-cyan-400 leading-none tracking-tight">$0.01</span>
                <span className="text-[13px] text-white/40 font-medium">/1000 tokens</span>
              </div>
            </div>
            <div>
              <p className="text-[13px] text-white/60 mb-2 font-medium">Search queries</p>
              <div className="flex items-baseline gap-1">
                <span className="text-[32px] font-bold text-cyan-400 leading-none tracking-tight">$0.10</span>
                <span className="text-[13px] text-white/40 font-medium">/1000 queries</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  )
}

function FeatureItem({ text, highlight = false }: { text: string; highlight?: boolean }) {
  return (
    <li className="flex items-center gap-3">
      <div className={`h-5 w-5 rounded-full flex items-center justify-center shrink-0 ${highlight ? 'bg-cyan-500/20 text-cyan-400' : 'text-white/40'}`}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="w-3.5 h-3.5">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <span className="text-[15px] text-white/80 font-medium">{text}</span>
    </li>
  )
}
