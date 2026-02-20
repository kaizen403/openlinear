import { Check, ClipboardList, Bot, GitPullRequest, DivideIcon as LucideIcon } from "lucide-react"
import { ReactNode } from "react"

export function HowItWorksSection() {
  return (
    <section className="relative py-32 md:py-40 overflow-hidden">
      <div className="absolute inset-0 bg-[#0a0f1a]" />
      
      <div className="absolute top-1/2 left-0 w-[600px] h-[600px] rounded-full bg-blue-500/5 blur-[150px] pointer-events-none -translate-y-1/2" />
      
      <div className="relative mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="text-center mb-20">
          <span className="inline-block px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-xs text-white/60 mb-6">
            How it works
          </span>
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-[-0.02em] text-white leading-[1.1]">
            From idea to merged PR
            <br />
            <span className="text-white/40">in three simple steps</span>
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-8 relative">
          <div className="hidden md:block absolute top-12 left-[20%] right-[20%] h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          
          <StepCard
            icon={<ClipboardList className="h-8 w-8 text-blue-400" />}
            title="Create a task"
            description="Add a task to your kanban board with a clear description. Tag it with priority and category. Our AI analyzes the requirements and estimates complexity."
            features={["Natural language input", "Auto-tagging", "Complexity estimation"]}
          />

          <StepCard
            icon={<Bot className="h-8 w-8 text-blue-400" />}
            title="AI takes over"
            description="Click 'Execute' and our AI agent clones your repo, creates a branch, and starts implementing. You can watch progress in real-time with full transparency."
            features={["Git integration", "Branch creation", "Real-time updates"]}
          />

          <StepCard
            icon={<GitPullRequest className="h-8 w-8 text-blue-400" />}
            title="Review & merge"
            description="The AI opens a pull request with the implementation. Review the code, request changes if needed, or merge directly. Quality is guaranteed."
            features={["PR creation", "Code review", "One-click merge"]}
          />
        </div>
      </div>
    </section>
  )
}

function StepCard({
  icon,
  title,
  description,
  features,
}: {
  icon: ReactNode
  title: string
  description: string
  features: string[]
}) {
  return (
    <div className="relative group">
      <div className="flex flex-col items-center text-center">
        <div className="relative mb-8">
          <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-blue-500/20 to-cyan-500/20 border border-blue-500/30 flex items-center justify-center">
            {icon}
          </div>
          <div className="absolute inset-0 rounded-2xl bg-blue-500/20 blur-xl opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>

        <h3 className="text-2xl font-semibold text-white mb-4">{title}</h3>
        
        <p className="text-white/50 leading-relaxed mb-6">{description}</p>

        <ul className="space-y-2">
          {features.map((feature) => (
            <li key={feature} className="flex items-center justify-center gap-2 text-sm text-white/60">
              <Check className="h-4 w-4 text-blue-400" />
              {feature}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
