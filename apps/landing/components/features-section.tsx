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
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex flex-col items-center justify-center p-6">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(56,189,248,0.05),transparent_70%)]" />
              
              <div className="w-[85%] bg-[#111111] border border-[#2a2a2a] rounded-xl shadow-2xl relative z-10 transform scale-95 group-hover:scale-100 transition-transform duration-500 text-left">
                <div className="p-3">
                  <div className="flex items-start gap-2">
                    <h4 className="text-sm text-[#f5f5f5] font-light leading-tight line-clamp-2 flex-1">
                      Implement dark mode toggle in settings
                    </h4>
                    <svg aria-hidden="true" className="w-3.5 h-3.5 animate-spin flex-shrink-0 mt-0.5 text-[#5e6ad2]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                  </div>
                  
                  <div className="flex flex-wrap gap-1.5 mt-3 mb-3">
                    <span className="text-[11px] px-2 py-0.5 h-5 font-medium rounded-[4px] inline-flex items-center border border-white/10" style={{ color: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.2)' }}>Feature</span>
                    <span className="text-[11px] px-2 py-0.5 h-5 font-medium rounded-[4px] inline-flex items-center border border-white/10" style={{ color: '#f97316', backgroundColor: 'rgba(249,115,22,0.2)' }}>Frontend</span>
                  </div>
                  
                  <div className="p-2 bg-white/[0.03] rounded-md mb-3 flex items-center gap-2">
                    <svg aria-hidden="true" className="w-3 h-3 animate-spin text-[#5e6ad2]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    <span className="text-xs text-[#a0a0a0]">Executing...</span>
                  </div>
                  
                  <div className="flex items-center justify-between mt-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[#6a6a6a] font-mono opacity-60">OPN-124</span>
                      <span className="text-[11px] text-[#6a6a6a] flex items-center gap-1">
                        <svg aria-hidden="true" className="w-3 h-3 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        02:45
                      </span>
                    </div>
                    <div className="flex items-center">
                      <div className="h-6 px-1.5 flex items-center text-[11px] text-red-400 font-medium">Cancel</div>
                    </div>
                  </div>
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
            <div className="h-[280px] rounded-[24px] bg-[#0a0e17] border border-white/[0.04] mb-6 relative overflow-hidden flex flex-col items-center justify-center">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_bottom,rgba(59,130,246,0.1),transparent_60%)]" />
              
              <div className="w-[85%] bg-[#111111] border border-[#2a2a2a] rounded-lg shadow-2xl relative z-10 flex flex-col overflow-hidden transform scale-95 group-hover:scale-100 transition-transform duration-500 text-left">
                <div className="flex items-center justify-between p-2 border-b border-[#2a2a2a] bg-[#141414]">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold text-[#f5f5f5] truncate">Execution Details</span>
                    <span className="text-[9px] text-[#6a6a6a]">Task OPN-124</span>
                  </div>
                  <svg aria-hidden="true" className="h-3 w-3 text-[#6a6a6a]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </div>
                
                <div className="px-3 py-2 border-b border-[#2a2a2a] bg-blue-500/10 flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  <span className="text-[11px] font-medium text-blue-400">Executing inside isolated container</span>
                </div>
                
                <div className="p-3 space-y-2 bg-[#111111]">
                  <div className="flex gap-2">
                    <svg aria-hidden="true" className="w-3 h-3 text-[#a0a0a0] mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    <div>
                       <div className="text-[#6a6a6a] text-[9px] font-mono mb-0.5">14:02:41</div>
                       <p className="text-[10px] text-[#a0a0a0]">Provisioning dedicated environment...</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <svg aria-hidden="true" className="w-3 h-3 text-[#a0a0a0] mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    <div>
                       <div className="text-[#6a6a6a] text-[9px] font-mono mb-0.5">14:02:45</div>
                       <p className="text-[10px] text-[#a0a0a0]">Mounting isolated worktree /tmp/worktree-124</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <svg aria-hidden="true" className="w-3 h-3 text-blue-400 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    <div>
                       <div className="text-[#6a6a6a] text-[9px] font-mono mb-0.5">14:02:46</div>
                       <p className="text-[10px] text-[#f5f5f5]">Agent spawned securely</p>
                    </div>
                  </div>
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
              
              <div className="w-[85%] bg-[#111111] border border-[#2a2a2a] rounded-lg shadow-2xl relative z-10 flex flex-col overflow-hidden transform scale-95 group-hover:scale-100 transition-transform duration-500 text-left h-[180px]">
                <div className="p-3 space-y-3 overflow-hidden">
                  <div className="flex gap-2">
                    <svg aria-hidden="true" className="w-3 h-3 text-yellow-400 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
                    <div className="min-w-0">
                       <div className="text-[#6a6a6a] text-[9px] font-mono mb-0.5">14:03:10</div>
                       <p className="text-[10px] text-yellow-400 truncate">Call Tool: read</p>
                       <p className="text-[9px] text-[#6a6a6a] font-mono truncate">{"{ \"filePath\": \"src/components/ui/button.tsx\" }"}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <svg aria-hidden="true" className="w-3 h-3 text-[#a0a0a0] mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
                    <div className="min-w-0">
                       <div className="text-[#6a6a6a] text-[9px] font-mono mb-0.5">14:03:12</div>
                       <p className="text-[10px] text-[#a0a0a0] truncate">Reading file contents (150 lines)</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <svg aria-hidden="true" className="w-3 h-3 text-blue-500 mt-0.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    <div className="min-w-0">
                       <div className="text-[#6a6a6a] text-[9px] font-mono mb-0.5">14:03:15</div>
                       <p className="text-[10px] text-blue-400 relative inline-flex items-center w-full">
                         <span className="truncate">I'll add the dark mode classes...</span>
                         <span className="ml-1 w-1 h-3 bg-blue-400 animate-pulse flex-shrink-0" />
                       </p>
                    </div>
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
