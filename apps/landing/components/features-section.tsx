export function FeaturesSection() {
  return (
    <section className="relative py-24 overflow-hidden bg-[#0a0f1a]">
      <div className="relative mx-auto max-w-[1200px] px-4">
        <div className="text-center mb-16">
          <h2 className="font-display text-[2.5rem] md:text-[3.5rem] font-bold tracking-tight text-white mb-4">
            AI-powered project management
          </h2>
          <p className="text-white/50 text-[17px] max-w-2xl mx-auto leading-relaxed">
            OpenLinear combines a Linear-style kanban board with AI coding agents. Manage tasks visually, and when you're ready, the AI clones your repo, creates a branch, writes the code, and opens a pull request.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          {/* Card 1: One-Click Execution */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.05),transparent_70%)]" />
              <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg width=\'60\' height=\'104\' viewBox=\'0 0 60 104\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cpath d=\'M30 0L60 17.3205v34.641L30 69.282 0 51.9615V17.3205L30 0zm0 34.641L15 25.9808v17.3205L30 51.9615l15-8.6603V25.9808L30 34.641z\' fill=\'%23ffffff\' fill-opacity=\'0.1\' fill-rule=\'evenodd\'/%3E%3C/svg%3E")' }} />
              
              <div className="relative w-full h-full flex items-center justify-center">
                <div className="absolute left-[20%] h-12 w-12 rounded-full bg-blue-500/20 border border-blue-500/50 flex items-center justify-center z-10 shadow-[0_0_15px_rgba(59,130,246,0.3)]">
                  <div className="w-0 h-0 border-t-[6px] border-t-transparent border-l-[10px] border-l-blue-400 border-b-[6px] border-b-transparent ml-1" />
                </div>
                
                <div className="absolute right-[20%] h-14 w-14 rounded-xl bg-green-500/10 border border-green-500/30 flex items-center justify-center z-10">
                  <svg viewBox="0 0 24 24" className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 6L6 18" />
                    <path d="M6 6L18 18" />
                  </svg>
                </div>

                {/* Git branch lines */}
                <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-40 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="4 4">
                  <path d="M 30% 50% Q 50% 50% 60% 40% T 75% 50%" className="animate-[dash_2s_linear_infinite]" />
                </svg>

                <div className="h-16 w-16 bg-[#0f1420] border border-white/10 rounded-xl flex items-center justify-center relative z-20 shadow-[0_0_20px_rgba(34,211,238,0.2)]">
                  <svg viewBox="0 0 24 24" className="w-8 h-8 text-cyan-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="18" r="3"></circle>
                    <circle cx="6" cy="6" r="3"></circle>
                    <path d="M13 6h3a2 2 0 0 1 2 2v7"></path>
                    <line x1="6" y1="9" x2="6" y2="21"></line>
                  </svg>
                </div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">One-Click Execution</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-6">
                Select a task, hit execute, and get a PR with real code changes. We handle the branching, committing, and pushing.
              </p>
            </div>
          </div>

          {/* Card 2: Container Isolation */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,rgba(59,130,246,0.1),transparent_60%)]" />
              
              <div className="relative flex items-center justify-center">
                <div className="absolute w-40 h-40 border-2 border-dashed border-blue-500/30 rounded-2xl group-hover:border-blue-400/50 transition-colors duration-500 animate-[spin_30s_linear_infinite]" />
                <div className="absolute w-32 h-32 bg-blue-500/5 border border-blue-500/20 rounded-xl" />
                
                <div className="h-16 w-16 bg-[#0f1420] border border-white/20 rounded-xl flex items-center justify-center relative z-10 shadow-[0_0_30px_rgba(59,130,246,0.3)]">
                  <svg viewBox="0 0 24 24" className="w-8 h-8 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2"></rect>
                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2"></rect>
                    <line x1="6" y1="6" x2="6.01" y2="6"></line>
                    <line x1="6" y1="18" x2="6.01" y2="18"></line>
                  </svg>
                </div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">Container Isolation</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-6">
                Every user gets a dedicated Docker container running their own AI agent with isolated credentials and git worktrees.
              </p>
            </div>
          </div>

          {/* Card 3: Real-Time Streaming */}
          <div className="rounded-[32px] bg-white/[0.02] border border-white/[0.06] p-4 flex flex-col h-full hover:bg-white/[0.04] transition-colors group">
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex flex-col items-center justify-center p-6">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(6,182,212,0.1),transparent_60%)]" />
              
              <div className="w-full bg-[#131823] border border-white/10 rounded-lg overflow-hidden shadow-2xl relative z-10">
                <div className="bg-white/5 px-3 py-2 flex items-center gap-2 border-b border-white/5">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
                  <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
                  <div className="ml-2 text-[10px] text-white/30 font-mono">agent-stream</div>
                </div>
                <div className="p-4 space-y-2 font-mono text-xs">
                  <div className="flex items-center gap-2 text-cyan-400/80">
                    <span className="opacity-50">&gt;</span>
                    <span>Analyzing codebase...</span>
                  </div>
                  <div className="flex items-center gap-2 text-green-400/80">
                    <span className="opacity-50">&gt;</span>
                    <span>Reading src/components/ui/button.tsx</span>
                  </div>
                  <div className="flex items-center gap-2 text-blue-400/80">
                    <span className="opacity-50">&gt;</span>
                    <span className="relative">
                      Writing implementation
                      <span className="absolute -right-2 top-0 bottom-0 w-1 bg-blue-400 animate-pulse" />
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="px-4 pb-4">
              <h3 className="text-[20px] font-semibold text-white mb-2">Real-Time Streaming</h3>
              <p className="text-white/50 text-[15px] leading-relaxed mb-6">
                Watch the AI work live via SSE. Every tool call, file edit, and decision is streamed directly to your browser as it happens.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
