import { Check } from "lucide-react"
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
              <div className="w-[280px] h-[180px] rounded-[16px] bg-[#0a0e17] border border-white/[0.04] relative overflow-hidden flex flex-col items-center justify-center mb-8 mx-auto group z-10">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.05),transparent_70%)]" />
                <div className="w-[85%] bg-[#111111] border border-[#2a2a2a] rounded-lg shadow-2xl relative z-10 transform scale-95 group-hover:scale-100 transition-transform duration-500 text-left p-3">
                   <div className="text-[11px] text-[#f5f5f5] font-medium mb-3 flex items-center justify-between">
                     <span>Todo</span>
                     <span className="text-[#6a6a6a]">1</span>
                   </div>
                   <div className="bg-[#141414] border border-[#2a2a2a] rounded-md p-3 mb-2">
                     <div className="text-[12px] text-[#f5f5f5] mb-2 font-light">Add authentication flow</div>
                     <div className="flex gap-1.5">
                       <span className="text-[10px] px-1.5 py-0.5 rounded-[4px] border border-white/10 text-blue-400 bg-blue-400/20">Feature</span>
                       <span className="text-[10px] px-1.5 py-0.5 rounded-[4px] border border-white/10 text-orange-400 bg-orange-400/20">Backend</span>
                     </div>
                   </div>
                   <div className="flex items-center gap-1.5 text-[11px] text-[#6a6a6a] mt-3 hover:text-[#f5f5f5] cursor-pointer transition-colors">
                     <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>
                     New Issue
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
              <div className="w-[280px] h-[180px] rounded-[16px] bg-[#0a0e17] border border-white/[0.04] relative overflow-hidden flex flex-col items-center justify-center mb-8 mx-auto group z-10">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(99,102,241,0.05),transparent_70%)]" />
                <div className="w-[85%] bg-[#111111] border border-[#2a2a2a] rounded-lg shadow-2xl relative z-10 transform scale-95 group-hover:scale-100 transition-transform duration-500 text-left flex flex-col overflow-hidden">
                  <div className="flex items-center justify-between p-2.5 border-b border-[#2a2a2a] bg-[#141414]">
                    <span className="text-[11px] font-semibold text-[#f5f5f5]">Executing</span>
                    <span className="text-[10px] text-[#6a6a6a] font-mono">00:12</span>
                  </div>
                  <div className="px-3 py-2 border-b border-[#2a2a2a] bg-[#1a1a2e] flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                    <span className="text-[11px] font-medium text-indigo-400">Writing implementation...</span>
                  </div>
                  <div className="p-3 bg-[#111111] space-y-2.5">
                    <div className="flex gap-2 items-center opacity-50">
                      <svg aria-hidden="true" className="w-3.5 h-3.5 text-[#a0a0a0]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                      <span className="text-[11px] text-[#a0a0a0]">Reading auth.ts</span>
                    </div>
                    <div className="flex gap-2 items-center opacity-50">
                      <svg aria-hidden="true" className="w-3.5 h-3.5 text-[#a0a0a0]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
                      <span className="text-[11px] text-[#a0a0a0]">Checking database schema</span>
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
              <div className="w-[280px] h-[180px] rounded-[16px] bg-[#0a0e17] border border-white/[0.04] relative overflow-hidden flex flex-col items-center justify-center mb-8 mx-auto group z-10">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(34,197,94,0.05),transparent_70%)]" />
                <div className="w-[85%] bg-[#111111] border border-[#2a2a2a] rounded-lg shadow-2xl relative z-10 transform scale-95 group-hover:scale-100 transition-transform duration-500 text-left p-4">
                   <div className="flex items-center gap-2 mb-3">
                     <svg aria-hidden="true" className="w-4 h-4 text-green-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
                     <span className="text-[12px] font-medium text-[#f5f5f5]">Ready for Review</span>
                   </div>
                   <div className="bg-green-500/10 border border-green-500/20 rounded-md px-3 py-2.5 mb-4 flex items-center gap-2 text-green-400 hover:bg-green-500/20 transition-colors cursor-pointer">
                     <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                     <span className="text-[11px]">Add authentication flow #42</span>
                   </div>
                   <div className="flex justify-end">
                     <div className="bg-[#f5f5f5] text-[#111111] hover:bg-white px-3 py-1.5 rounded-md text-[11px] font-medium cursor-pointer transition-colors">
                       Merge PR
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
