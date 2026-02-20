import { Check, CheckCircle2, ExternalLink, FileCode2, GitPullRequest, Loader2, Plus } from "lucide-react"
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
          <div className="hidden md:block absolute top-20 left-[20%] right-[20%] h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent z-0" />
          
          <StepCard
            visual={
              <div className="w-[280px] h-[180px] rounded-[16px] bg-[#0A0D14] border border-[#1E2330] relative overflow-hidden flex flex-col items-center justify-center mb-8 mx-auto group z-10">
                <div className="w-[86%] h-[84%] rounded-[12px] border border-white/[0.08] bg-gradient-to-b from-white/[0.02] to-transparent overflow-hidden shadow-[0_8px_28px_-14px_rgba(0,0,0,0.7)]">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06] bg-white/[0.02]">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Todo</span>
                      <span className="h-4 min-w-4 px-1 rounded border border-white/[0.08] bg-white/[0.06] text-[10px] leading-4 text-zinc-400 text-center">1</span>
                    </div>
                    <Plus className="w-3.5 h-3.5 text-zinc-500" />
                  </div>
                  <div className="p-2.5">
                    <div className="rounded-xl bg-white/[0.03] backdrop-blur-md border border-white/[0.08] shadow-[0_4px_24px_-8px_rgba(0,0,0,0.4)] p-2.5">
                      <p className="text-[11px] font-light leading-tight text-white/85 mb-2">Add authentication flow</p>
                      <div className="flex gap-1.5 mb-2">
                        <span className="text-[10px] px-2 py-0.5 h-5 rounded-[4px] inline-flex items-center border border-white/10 bg-[#60a5fa]/20 text-[#60a5fa] font-medium">Feature</span>
                        <span className="text-[10px] px-2 py-0.5 h-5 rounded-[4px] inline-flex items-center border border-white/10 bg-[#f97316]/20 text-[#f97316] font-medium">Backend</span>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-zinc-500">
                        <span className="font-mono opacity-70">PROJ-42</span>
                        <span>Today</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            }
            title="Create a task"
            description="Add a task to your kanban board with a clear description. Tag it with priority and category. Our AI analyzes the requirements and estimates complexity."
            features={["Natural language input", "Auto-tagging", "Complexity estimation"]}
          />

          <StepCard
            visual={
              <div className="w-[280px] h-[180px] rounded-[16px] bg-[#0A0D14] border border-[#1E2330] relative overflow-hidden flex flex-col items-center justify-center mb-8 mx-auto group z-10">
                <div className="w-[86%] h-[84%] rounded-[12px] border border-white/[0.08] bg-white/[0.02] overflow-hidden shadow-[0_8px_28px_-14px_rgba(0,0,0,0.7)]">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06] bg-white/[0.02]">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-300">Execution Logs</span>
                    <span className="text-[10px] text-zinc-500 font-mono">00:12</span>
                  </div>
                  <div className="px-3 py-2 border-b border-white/[0.06] bg-[#1d4ed8]/12">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin text-[#5e6ad2]" />
                      <span className="text-[11px] font-medium text-[#7c8bff]">Running OpenCode</span>
                    </div>
                    <p className="text-[10px] text-zinc-400 mt-1">Writing implementation...</p>
                  </div>
                  <div className="p-2.5 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <FileCode2 className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-[10px] text-zinc-400">Reading <span className="font-mono">auth.ts</span></span>
                    </div>
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-[10px] text-zinc-400">Checking database schema</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <GitPullRequest className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-[10px] text-zinc-400">Preparing PR metadata</span>
                    </div>
                  </div>
                </div>
              </div>
            }
            title="AI takes over"
            description="Click 'Execute' and our AI agent clones your repo, creates a branch, and starts implementing. You can watch progress in real-time with full transparency."
            features={["Git integration", "Branch creation", "Real-time updates"]}
          />

          <StepCard
            visual={
              <div className="w-[280px] h-[180px] rounded-[16px] bg-[#0A0D14] border border-[#1E2330] relative overflow-hidden flex flex-col items-center justify-center mb-8 mx-auto group z-10">
                <div className="w-[86%] h-[84%] rounded-[12px] border border-white/[0.08] bg-gradient-to-b from-white/[0.02] to-transparent overflow-hidden shadow-[0_8px_28px_-14px_rgba(0,0,0,0.7)]">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.06] bg-white/[0.02]">
                    <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">Done</span>
                    <span className="h-4 min-w-4 px-1 rounded border border-emerald-500/25 bg-emerald-500/12 text-[10px] leading-4 text-emerald-300 text-center">1</span>
                  </div>
                  <div className="p-2.5">
                    <div className="rounded-xl bg-white/[0.03] backdrop-blur-md border border-white/[0.08] shadow-[0_4px_24px_-8px_rgba(0,0,0,0.4)] p-2.5">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <p className="text-[11px] font-light leading-tight text-white/85">Add authentication flow</p>
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                      </div>
                      <button
                        type="button"
                        className="flex items-center gap-1 text-[10px] text-blue-400 hover:underline"
                      >
                        <ExternalLink className="w-3 h-3" />
                        View PR
                      </button>
                      <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[10px] text-zinc-500">
                        <span className="font-mono opacity-70">PROJ-42</span>
                        <span>Completed</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            }
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
  visual,
  title,
  description,
  features,
}: {
  visual: ReactNode
  title: string
  description: string
  features: string[]
}) {
  return (
    <div className="relative group">
      <div className="flex flex-col items-center text-center">
        {visual}

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
