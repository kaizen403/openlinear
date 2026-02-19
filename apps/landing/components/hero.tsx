"use client"

import { ArrowRight, GitBranch, Sparkles, Send, CheckCircle2, Play, GitMerge, Clock, Cpu, Zap } from "lucide-react"

export function Hero() {
  return (
    <section className="relative min-h-screen flex flex-col overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-[#0a0f1a] via-[#0d1424] to-[#0f172a]" />
      
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1200px] h-[600px] rounded-full bg-[radial-gradient(ellipse_50%_50%_at_50%_0%,hsl(220_70%_30%/0.4),transparent_70%)] blur-[100px] pointer-events-none" />
      
      <div className="absolute top-[20%] left-[10%] w-[500px] h-[500px] rounded-full bg-[radial-gradient(circle,hsl(250_60%_40%/0.15),transparent_70%)] blur-[120px] pointer-events-none animate-pulse" style={{ animationDuration: '8s' }} />
      
      <div className="absolute top-[30%] right-[5%] w-[400px] h-[400px] rounded-full bg-[radial-gradient(circle,hsl(200_70%_35%/0.12),transparent_70%)] blur-[100px] pointer-events-none animate-pulse" style={{ animationDuration: '10s', animationDelay: '2s' }} />
      
      <div className="absolute inset-0 opacity-[0.015]" style={{
        backgroundImage: `linear-gradient(rgba(255,255,255,0.15) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.15) 1px, transparent 1px)`,
        backgroundSize: '80px 80px'
      }} />

      <div className="relative flex-1 flex flex-col items-center justify-center text-center px-4 sm:px-6 lg:px-8 pt-32 pb-20">
        <div className="hero-reveal-1 mb-8">
          <a 
            href="/product" 
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/[0.03] border border-white/[0.08] text-sm text-white/60 hover:text-white/80 hover:bg-white/[0.05] transition-all duration-300"
          >
            <span className="flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            <span>OpenLinear is now in public beta</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>

        <h1 className="hero-reveal-2 font-display text-[2.5rem] sm:text-[3rem] md:text-[4rem] lg:text-[4.5rem] xl:text-[5rem] font-bold tracking-[-0.03em] text-white leading-[1.1] max-w-5xl">
          The AI-powered
          <br />
          <span className="bg-gradient-to-r from-blue-400 via-cyan-400 to-blue-300 bg-clip-text text-transparent">
            execution platform
          </span>
          <br />
          for your codebase
        </h1>

        {/* Subtext / Motto */}
        <p className="hero-reveal-3 mt-6 text-lg sm:text-xl text-white/50 max-w-2xl leading-relaxed">
          Create tasks on a kanban board. Let AI agents execute them.
          Review pull requests. Ship faster.
        </p>

        <div className="hero-reveal-4 flex flex-wrap items-center justify-center gap-4 mt-10">
          <a
            href="https://dashboard.rixie.in"
            className="group inline-flex items-center gap-2.5 rounded-full bg-white px-6 py-3.5 text-sm font-semibold text-[#0a0f1a] hover:bg-white/90 transition-all duration-300 shadow-lg shadow-white/10"
          >
            <Zap className="h-4 w-4" />
            Get Started Free
          </a>
          <a
            href="https://github.com/kaizen403/openlinear"
            className="group inline-flex items-center gap-2.5 rounded-full bg-white/[0.03] border border-white/[0.1] px-6 py-3.5 text-sm font-medium text-white/70 hover:text-white hover:bg-white/[0.06] hover:border-white/[0.15] transition-all duration-300"
          >
            <GitBranch className="h-4 w-4" />
            View on GitHub
            <ArrowRight className="h-3.5 w-3.5 transition-transform duration-300 group-hover:translate-x-1" />
          </a>
        </div>

        <div className="hero-reveal-5 flex flex-wrap items-center justify-center gap-8 mt-12 text-white/40">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            <span className="text-sm">Open source</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            <span className="text-sm">Self-hosted</span>
          </div>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-400" />
            <span className="text-sm">GitHub integration</span>
          </div>
        </div>
      </div>

      <div className="relative px-4 sm:px-6 lg:px-8 pb-20">
        <div className="relative mx-auto max-w-6xl">
          <div className="relative" style={{ perspective: '1000px' }}>
            <div 
              className="relative rounded-2xl border border-white/[0.08] bg-gradient-to-b from-white/[0.08] to-white/[0.02] backdrop-blur-sm overflow-hidden"
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

              <div className="absolute -top-6 -right-6 w-48 glass-panel rounded-xl p-4 border border-white/[0.08] shadow-2xl animate-float-2 hidden lg:block">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-full bg-green-500/20 flex items-center justify-center">
                    <GitMerge className="h-4 w-4 text-green-400" />
                  </div>
                  <div>
                    <p className="text-xs text-white/60">PR Created</p>
                    <p className="text-sm text-white/90 font-medium">feat/oauth-provider</p>
                  </div>
                </div>
              </div>

              <div className="absolute -bottom-4 -left-4 w-44 glass-panel rounded-xl p-3.5 border border-white/[0.08] shadow-2xl animate-float-4 hidden lg:block">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Send className="h-4 w-4 text-blue-400" />
                    <span className="text-sm text-white/80">3 PRs</span>
                  </div>
                  <span className="text-xs text-green-400">merged today</span>
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
