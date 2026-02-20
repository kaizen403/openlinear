"use client"

import { ArrowRight, GitBranch, Sparkles, Send, CheckCircle2, Play, GitMerge, Clock, Cpu, FileText, Image as ImageIcon, Link2, MessageSquare, Zap } from "lucide-react"

export function Hero() {
  return (
    <section className="relative min-h-screen flex flex-col overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0f1a] via-[#0d1424] to-[#0f172a]" />
      
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1400px] h-[700px] rounded-full bg-[radial-gradient(ellipse_50%_50%_at_50%_0%,hsl(220_70%_35%/0.5),transparent_70%)] blur-[120px] pointer-events-none" />
      
      <div className="absolute top-[10%] left-[5%] w-[600px] h-[600px] rounded-full bg-[radial-gradient(circle,hsl(250_60%_45%/0.2),transparent_70%)] blur-[140px] pointer-events-none animate-pulse" style={{ animationDuration: '8s' }} />
      
      <div className="absolute top-[20%] right-[0%] w-[500px] h-[500px] rounded-full bg-[radial-gradient(circle,hsl(200_80%_40%/0.15),transparent_70%)] blur-[120px] pointer-events-none animate-pulse" style={{ animationDuration: '10s', animationDelay: '2s' }} />
      
      <div className="absolute inset-0 opacity-[0.02]" style={{
        backgroundImage: `linear-gradient(rgba(255,255,255,0.2) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.2) 1px, transparent 1px)`,
        backgroundSize: '100px 100px'
      }} />

      <div className="relative flex-1 flex flex-col items-center justify-center text-center px-4 sm:px-6 lg:px-8 pt-28 pb-16">
        <div className="hero-reveal-1 mb-8">
          <a 
            href="/product" 
            className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full bg-white/[0.04] border border-white/[0.08] text-sm text-white/70 hover:text-white hover:bg-white/[0.06] hover:border-white/[0.12] transition-all duration-300 group"
          >
            <span className="flex items-center gap-1.5">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-60"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              <span className="text-blue-400 font-medium">Product</span>
            </span>
            <span className="w-[1px] h-4 bg-white/10"></span>
            <span className="text-white/60 group-hover:text-white/80">OpenLinear is now the best task execution platform</span>
            <ArrowRight className="h-3.5 w-3.5 text-white/40 group-hover:text-white/60 transition-transform duration-300 group-hover:translate-x-0.5" />
          </a>
        </div>

        <h1 className="hero-reveal-2 font-display text-[3rem] sm:text-[3.5rem] md:text-[4.5rem] lg:text-[5.5rem] xl:text-[6rem] font-bold tracking-[-0.02em] text-white leading-[1.05] max-w-6xl">
          Project management
          <br />
          <span className="bg-gradient-to-r from-blue-400 via-cyan-300 to-blue-400 bg-clip-text text-transparent">
            that actually writes
          </span>
          <br />
          the code
        </h1>

        <p className="hero-reveal-3 mt-8 text-lg sm:text-xl text-white/50 max-w-2xl leading-relaxed">
          Don't just track tasks. OpenLinear's AI agents clone your repo, write the implementation, and open a PR—straight from your kanban board.
        </p>

        <div className="hero-reveal-4 flex flex-wrap items-center justify-center gap-4 mt-12">
          <a
            href="https://dashboard.rixie.in"
            className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-b from-blue-500 to-blue-600 px-6 py-3.5 text-sm font-medium text-white hover:from-blue-400 hover:to-blue-500 transition-all duration-300 shadow-lg shadow-blue-500/25"
          >
            Setup in 5 mins
          </a>
          <a
            href="https://github.com/kaizen403/openlinear"
            className="group inline-flex items-center gap-2 rounded-xl bg-white/[0.03] border border-white/[0.15] px-6 py-3.5 text-sm font-medium text-white/80 hover:text-white hover:bg-white/[0.06] hover:border-white/[0.25] transition-all duration-300"
          >
            Talk to founder
            <ArrowRight className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5" />
          </a>
        </div>
      </div>

      <div className="relative px-4 sm:px-6 lg:px-8 pb-24">
        <div className="relative mx-auto max-w-6xl">
          {/* Floating memory cards - left side */}
          <div className="absolute -left-4 lg:-left-20 top-20 z-20 hidden md:block">
            <div className="glass-panel rounded-2xl p-4 border border-white/[0.08] shadow-2xl animate-float-1 w-56">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center border border-white/[0.08]">
                  <MessageSquare className="h-5 w-5 text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/40 mb-1">Task</p>
                  <p className="text-sm text-white/90 font-medium truncate">Add dark mode toggle</p>
                  <div className="flex items-center gap-1.5 mt-2">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">High</span>
                    <span className="text-[10px] text-white/30">UI</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Floating memory cards - right side */}
          <div className="absolute -right-4 lg:-right-16 top-32 z-20 hidden md:block">
            <div className="glass-panel rounded-2xl p-4 border border-white/[0.08] shadow-2xl animate-float-3 w-52">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-green-500/20 to-emerald-500/20 flex items-center justify-center border border-white/[0.08]">
                  <GitMerge className="h-5 w-5 text-green-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-white/40 mb-1">PR Created</p>
                  <p className="text-sm text-white/90 font-medium truncate">feat/oauth-flow</p>
                  <p className="text-[10px] text-green-400 mt-1">Ready to merge</p>
                </div>
              </div>
            </div>
          </div>

          {/* Floating card - bottom left */}
          <div className="absolute -left-8 lg:-left-12 bottom-32 z-20 hidden lg:block">
            <div className="glass-panel rounded-2xl p-3.5 border border-white/[0.08] shadow-2xl animate-float-4 w-44">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center">
                  <ImageIcon className="h-4 w-4 text-orange-400" />
                </div>
                <div>
                  <p className="text-xs text-white/90 font-medium">14,782</p>
                  <p className="text-[10px] text-white/40">Tasks completed</p>
                </div>
              </div>
            </div>
          </div>

          {/* Floating card - bottom right */}
          <div className="absolute -right-6 lg:-right-8 bottom-24 z-20 hidden lg:block">
            <div className="glass-panel rounded-2xl p-3.5 border border-white/[0.08] shadow-2xl animate-float-2 w-48">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-white/60">Execution</span>
                <div className="flex gap-1">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-400/50 animate-pulse delay-75" />
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-400/25 animate-pulse delay-150" />
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div className="h-full w-[75%] bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full" />
                </div>
                <p className="text-[10px] text-white/40">Processing auth flow...</p>
              </div>
            </div>
          </div>

          <div className="relative" style={{ perspective: '1000px' }}>
            <div 
              className="relative rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.08] to-white/[0.02] backdrop-blur-sm overflow-hidden shadow-2xl shadow-black/50"
              style={{ transform: 'rotateX(5deg) rotateY(0deg)' }}
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
                <div className="flex items-center gap-3">
                  <div className="flex gap-1.5">
                    <div className="h-3 w-3 rounded-full bg-red-400/80" />
                    <div className="h-3 w-3 rounded-full bg-yellow-400/80" />
                    <div className="h-3 w-3 rounded-full bg-green-400/80" />
                  </div>
                  <div className="h-4 w-[1px] bg-white/10 mx-2" />
                  <span className="text-sm text-white/40 font-mono">openlinear.dev</span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/[0.03] border border-white/[0.06]">
                    <Sparkles className="h-3.5 w-3.5 text-blue-400" />
                    <span className="text-xs text-white/60">AI Agent Active</span>
                  </div>
                </div>
              </div>

              <div className="p-6">
                <div className="grid grid-cols-4 gap-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-2">
                      <span className="text-xs font-medium text-white/60 uppercase tracking-wider">Todo</span>
                      <span className="text-xs text-white/30 bg-white/[0.05] px-2 py-0.5 rounded-full">3</span>
                    </div>
                    <div className="space-y-2.5">
                      <TaskCard title="Add dark mode toggle" priority="High" label="UI" />
                      <TaskCard title="Fix API auth flow" priority="Medium" label="Backend" />
                      <TaskCard title="Update README docs" priority="Low" label="Docs" />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-2">
                      <span className="text-xs font-medium text-white/60 uppercase tracking-wider">In Progress</span>
                      <span className="text-xs text-white/30 bg-white/[0.05] px-2 py-0.5 rounded-full">2</span>
                    </div>
                    <div className="space-y-2.5">
                      <TaskCard 
                        title="Implement rate limiting" 
                        priority="High" 
                        label="Backend"
                        executing
                      />
                      <TaskCard title="Refactor auth middleware" priority="Medium" label="Security" />
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-2">
                      <span className="text-xs font-medium text-blue-400 uppercase tracking-wider">Executing</span>
                      <span className="text-xs text-blue-400/60 bg-blue-500/10 px-2 py-0.5 rounded-full animate-pulse">1</span>
                    </div>
                    <div className="space-y-2.5">
                      <div className="relative group">
                        <div className="absolute -inset-[1px] bg-gradient-to-r from-blue-500/20 via-cyan-500/20 to-blue-500/20 rounded-lg blur-sm animate-pulse" />
                        <div className="relative p-3.5 rounded-lg bg-[#0a0f1a]/80 border border-blue-500/20">
                          <div className="flex items-center gap-2 mb-2">
                            <div className="h-6 w-6 rounded-full bg-blue-500/20 flex items-center justify-center">
                              <Cpu className="h-3 w-3 text-blue-400 animate-pulse" />
                            </div>
                            <span className="text-xs text-blue-400 font-medium">AI Executing</span>
                          </div>
                          <p className="text-sm text-white/80 font-medium mb-2">Add OAuth provider</p>
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2 text-xs text-white/40">
                              <GitBranch className="h-3 w-3" />
                              <span>feat/oauth-provider</span>
                            </div>
                            <div className="flex items-center gap-2 text-xs text-white/40">
                              <Clock className="h-3 w-3" />
                              <span>Running for 2m 34s</span>
                            </div>
                          </div>
                          <div className="mt-3 h-1 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full w-[65%] bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full animate-pulse" />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between px-2">
                      <span className="text-xs font-medium text-white/60 uppercase tracking-wider">Done</span>
                      <span className="text-xs text-white/30 bg-white/[0.05] px-2 py-0.5 rounded-full">4</span>
                    </div>
                    <div className="space-y-2.5">
                      <TaskCard title="Setup CI/CD pipeline" priority="High" label="DevOps" done />
                      <TaskCard title="Create landing page" priority="Medium" label="Frontend" done />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Center floating card below */}
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-8 z-20 hidden lg:block">
            <div className="glass-panel rounded-2xl p-4 border border-white/[0.08] shadow-2xl animate-float-1">
              <div className="flex items-center gap-3">
                <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-500/20 to-blue-500/20 flex items-center justify-center border border-white/[0.08]">
                  <Zap className="h-6 w-6 text-blue-400" />
                </div>
                <div>
                  <p className="text-sm text-white/90 font-medium">OpenLinear</p>
                  <p className="text-xs text-white/40">AI-powered execution</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function TaskCard({ 
  title, 
  priority, 
  label, 
  executing = false, 
  done = false 
}: { 
  title: string
  priority: string
  label: string
  executing?: boolean
  done?: boolean
}) {
  const priorityColors: Record<string, string> = {
    High: 'bg-red-500/20 text-red-400',
    Medium: 'bg-yellow-500/20 text-yellow-400',
    Low: 'bg-blue-500/20 text-blue-400'
  }

  return (
    <div className={`p-3.5 rounded-lg bg-white/[0.03] border border-white/[0.06] hover:border-white/[0.1] transition-all duration-200 ${done ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${priorityColors[priority]}`}>
          {priority}
        </span>
        <span className="text-[10px] text-white/40 px-1.5 py-0.5 rounded bg-white/[0.05]">
          {label}
        </span>
      </div>
      <p className={`text-sm font-medium ${done ? 'text-white/50 line-through' : 'text-white/80'}`}>
        {done && <CheckCircle2 className="h-3.5 w-3.5 inline mr-1.5 text-green-400" />}
        {title}
      </p>
    </div>
  )
}
