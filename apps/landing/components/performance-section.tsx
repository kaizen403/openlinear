import { Zap, Brain, DollarSign } from "lucide-react"

export function PerformanceSection() {
  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-[#0a0f1a]" />

      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] lg:text-[4rem] font-bold tracking-[-0.02em] text-white leading-[1.1]">
            Best latency, quality, and cost.
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <PerformanceCard
            icon={Zap}
            badge="Execution time"
            title="Best-in-class execution speed"
            comparison={[
              { name: "Manual workflow", time: "2-3 hrs", slow: true },
              { name: "Traditional agency", time: "2-3 days", slow: true },
              { name: "OpenLinear", time: "<10 min", highlight: true },
            ]}
            description="OpenLinear executes tasks in minutes — up to 10× faster than manual workflows and 100× faster than traditional development cycles."
          />

          <PerformanceCard
            icon={Brain}
            badge="Quality"
            title="Code quality like senior engineers"
            visual="brain"
            description="We built OpenLinear to generate production-ready code following best practices, with proper error handling, testing, and documentation."
          />

          <PerformanceCard
            icon={DollarSign}
            badge="Cost"
            title="Do more, spend less"
            highlight="$0.01"
            subhighlight="per task"
            description="Forget burning cash on expensive contractors. With OpenLinear you get senior-level development at 90% lower cost."
          />
        </div>
      </div>
    </section>
  )
}

function PerformanceCard({
  icon: Icon,
  badge,
  title,
  comparison,
  visual,
  highlight,
  subhighlight,
  description,
}: {
  icon: React.ComponentType<{ className?: string }>
  badge: string
  title: string
  comparison?: { name: string; time: string; slow?: boolean; highlight?: boolean }[]
  visual?: string
  highlight?: string
  subhighlight?: string
  description: string
}) {
  return (
    <div className="group relative rounded-3xl bg-white/[0.02] border border-white/[0.06] overflow-hidden hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-500">
      <div className="p-6">
        <span className="inline-block px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 mb-4">
          {badge}
        </span>

        {comparison && (
          <div className="space-y-3 mb-6">
            {comparison.map((item, i) => (
              <div key={i} className={`flex items-center justify-between p-3 rounded-xl ${item.highlight ? 'bg-blue-500/10 border border-blue-500/20' : 'bg-white/[0.02]'}`}>
                <div className="flex items-center gap-3">
                  {item.highlight ? (
                    <div className="h-8 w-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                      <Icon className="h-4 w-4 text-blue-400" />
                    </div>
                  ) : (
                    <div className="h-8 w-8 rounded-lg bg-white/[0.04] flex items-center justify-center">
                      <span className="text-xs text-white/40">{item.name[0]}</span>
                    </div>
                  )}
                  <span className={`text-sm ${item.highlight ? 'text-white font-medium' : 'text-white/50'}`}>{item.name}</span>
                </div>
                <span className={`text-sm font-mono ${item.highlight ? 'text-blue-400' : 'text-white/30'}`}>{item.time}</span>
              </div>
            ))}
          </div>
        )}

        {visual === "brain" && (
          <div className="h-40 flex items-center justify-center mb-6 relative">
            <div className="absolute inset-0 bg-blue-500/5 rounded-2xl" />
            <div className="relative w-24 h-24">
              <div className="absolute inset-0 rounded-full border-2 border-blue-500/20" />
              <div className="absolute inset-4 rounded-full border-2 border-blue-500/30" />
              <div className="absolute inset-8 rounded-full bg-blue-500/20 flex items-center justify-center">
                <div className="h-8 w-8 rounded-lg bg-blue-500/30 flex items-center justify-center">
                  <Icon className="h-4 w-4 text-blue-400" />
                </div>
              </div>
              
              {[...Array(6)].map((_, i) => (
                <div
                  key={i}
                  className="absolute w-2 h-2 rounded-full bg-blue-400/40"
                  style={{
                    top: `${20 + Math.random() * 60}%`,
                    left: `${20 + Math.random() * 60}%`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {highlight && (
          <div className="text-center mb-6 py-6">
            <div className="text-6xl font-bold text-transparent bg-clip-text bg-gradient-to-b from-blue-300 to-blue-600">
              {highlight}
            </div>
            {subhighlight && (
              <div className="text-sm text-white/40 mt-1">{subhighlight}</div>
            )}
          </div>
        )}

        <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
        
        <p className="text-white/50 leading-relaxed text-sm">{description}</p>
      </div>
    </div>
  )
}
