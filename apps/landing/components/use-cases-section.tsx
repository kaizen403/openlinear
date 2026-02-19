import { Code2, Rocket, Shield, Clock } from "lucide-react"

export function UseCasesSection() {
  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0f1a] via-[#0d1424] to-[#0a0f1a]" />
      
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-16">
          <span className="inline-block px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 mb-6">
            Use cases
          </span>
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-[-0.02em] text-white leading-[1.1]">
            Built for every developer
          </h2>
          <p className="mt-6 text-lg text-white/50 max-w-3xl mx-auto">
            Whether you are a solo developer or part of a large team, OpenLinear adapts to your workflow and helps you ship faster.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <UseCaseCard
            icon={Code2}
            title="Solo Developers"
            description="Stop context switching between project management and coding. Describe what you want, let AI implement it while you focus on architecture and review."
            stats="10x faster iteration"
          />

          <UseCaseCard
            icon={Rocket}
            title="Startup Teams"
            description="Move fast without breaking things. OpenLinear helps small teams punch above their weight by automating the repetitive coding tasks."
            stats="3x more features shipped"
          />

          <UseCaseCard
            icon={Shield}
            title="Enterprise Engineering"
            description="Maintain code quality at scale. Every AI-generated change goes through your existing review process with full audit trails."
            stats="40% reduction in bugs"
          />

          <UseCaseCard
            icon={Clock}
            title="Agencies & Consultancies"
            description="Deliver client projects faster. Standardize implementations across projects while maintaining flexibility for custom requirements."
            stats="2x project turnaround"
          />
        </div>
      </div>
    </section>
  )
}

function UseCaseCard({
  icon: Icon,
  title,
  description,
  stats,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  description: string
  stats: string
}) {
  return (
    <div className="group relative rounded-3xl bg-white/[0.02] border border-white/[0.06] p-8 hover:bg-white/[0.04] hover:border-white/[0.1] transition-all duration-500">
      <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-blue-500/5 to-cyan-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
      
      <div className="relative">
        <div className="flex items-start justify-between mb-6">
          <div className="h-12 w-12 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
            <Icon className="h-6 w-6 text-blue-400" />
          </div>
          
          <span className="px-3 py-1 rounded-full bg-blue-500/10 text-blue-400 text-xs font-medium">
            {stats}
          </span>
        </div>

        <h3 className="text-xl font-semibold text-white mb-3">{title}</h3>
        
        <p className="text-white/50 leading-relaxed">{description}</p>
      </div>
    </div>
  )
}
