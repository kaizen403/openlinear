"use client"

import { ArrowRight, GitBranch, Sparkles, Send, CheckCircle2, Play, GitMerge, Clock, Cpu } from "lucide-react"

export function Hero() {
  return (
    <section className="relative min-h-[100svh] flex items-center overflow-hidden">
      {/* ── Rich atmospheric background ──────────────── */}
      <div className="absolute inset-0 bg-[#161820]" />

      {/* Warm glow - top center */}
      <div className="absolute top-[-10%] left-[30%] w-[900px] h-[700px] rounded-full bg-[hsl(45_30%_30%/0.15)] blur-[150px] pointer-events-none" />

      {/* Blue wash - right */}
      <div className="absolute top-[20%] right-[-5%] w-[600px] h-[800px] rounded-full bg-[hsl(220_50%_25%/0.2)] blur-[180px] pointer-events-none" />

      {/* Warm accent - bottom left */}
      <div className="absolute bottom-[-10%] left-[10%] w-[500px] h-[500px] rounded-full bg-[hsl(40_25%_20%/0.12)] blur-[160px] pointer-events-none" />

      {/* Subtle grid overlay */}
      <div className="absolute inset-0 opacity-[0.03]" style={{
        backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
        backgroundSize: '60px 60px'
      }} />

      {/* Horizon line */}
      <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

      {/* ── Content ──────────────────────────────────── */}
      <div className="relative mx-auto max-w-none px-[100px] pt-40 pb-36 w-full">
        <div className="grid lg:grid-cols-[1fr_1.3fr] gap-16 lg:gap-10 items-center">

          {/* Copy */}
          <div className="flex flex-col gap-8 z-10">
            <h1 className="hero-reveal-1 font-display text-[2.75rem] md:text-[3.75rem] lg:text-[4.5rem] font-bold tracking-[-0.05em] text-[#EDE8D0] leading-[1.02]">
              <span className="text-balance">
                Execute your tasks.{" "}
                <br />
                <span className="text-[#EDE8D0]">Don&apos;t just track them.</span>
              </span>
            </h1>

            <div className="hero-reveal-2 flex flex-wrap items-center gap-3.5 pt-1">
              <a
                href="https://dashboard.rixie.in"
                className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-7 py-3 text-[0.875rem] font-medium text-primary-foreground"
              >
                Get Started <ArrowRight className="h-3.5 w-3.5" />
              </a>
              <a
                href="https://github.com/kaizen403/openlinear"
                className="btn-secondary inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.03] px-7 py-3 text-[0.875rem] font-medium text-[#EDE8D0]/70"
              >
                View on GitHub
              </a>
            </div>
          </div>

          {/* ── Floating glass panels ────────────────── */}
          <div className="hero-reveal-3 relative h-[560px] hidden lg:block">

            {/* Card 1 – AI Agent (top-left, main card) */}
            <div className="absolute top-0 left-0 w-[320px] glass-panel rounded-2xl p-5 z-20 animate-float-1">
              <div className="flex items-start gap-3.5">
                <div className="h-9 w-9 rounded-xl bg-[#EDE8D0]/[0.08] flex items-center justify-center shrink-0 border border-[#EDE8D0]/[0.06]">
                  <Sparkles className="h-4 w-4 text-[#EDE8D0]/60" />
                </div>
                <div className="flex flex-col gap-1.5 flex-1">
                  <p className="text-[0.8125rem] font-semibold text-[#EDE8D0]/90 tracking-[-0.01em]">AI Agent</p>
                  <p className="text-[0.75rem] text-[#EDE8D0]/35 leading-[1.6]">
                    Task &apos;Add dark mode toggle&apos; is being implemented. Creating branch and running agent...
                  </p>
                  <div className="mt-2 h-1.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
                    <div className="h-full w-[65%] rounded-full bg-gradient-to-r from-[#EDE8D0]/40 to-[#EDE8D0]/20 animate-pulse" />
                  </div>
                </div>
              </div>
            </div>

            {/* Card 2 – PR Created (top-right) */}
            <div className="absolute top-12 right-0 w-[280px] glass-panel rounded-2xl p-5 z-30 animate-float-2">
              <div className="flex items-center gap-2.5 mb-3">
                <div className="h-7 w-7 rounded-lg bg-green-500/10 flex items-center justify-center border border-green-500/10">
                  <GitMerge className="h-3.5 w-3.5 text-green-400/80" />
                </div>
                <p className="text-[0.8125rem] font-semibold text-[#EDE8D0]/90 tracking-[-0.01em]">PR Created</p>
              </div>
              <div className="flex flex-col gap-1.5 pl-[38px]">
                <p className="text-[0.8125rem] font-medium text-[#EDE8D0]/70">feat: add dark mode toggle</p>
                <p className="text-[0.6875rem] text-[#EDE8D0]/30 leading-[1.55]">
                  Branch feature/dark-mode ready for review
                </p>
              </div>
            </div>

            {/* Card 3 – Execution Queue (center, large) */}
            <div className="absolute top-[200px] left-[40px] w-[340px] glass-panel rounded-2xl overflow-hidden z-20 animate-float-3">
              <div className="px-5 py-3.5 border-b border-white/[0.04] flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <Cpu className="h-3.5 w-3.5 text-[#EDE8D0]/60" />
                  <p className="text-[0.75rem] font-semibold text-[#EDE8D0]/60 tracking-wide uppercase">Execution Queue</p>
                </div>
                <span className="text-[0.6875rem] text-[#EDE8D0]/25 font-mono">3 tasks</span>
              </div>
              <div className="divide-y divide-white/[0.03]">
                {[
                  { name: "Add auth flow", status: "Running", statusColor: "text-green-400", icon: Play },
                  { name: "Fix API routes", status: "Queued", statusColor: "text-yellow-400/70", icon: Clock },
                  { name: "Update README", status: "Done", statusColor: "text-[#EDE8D0]/60", icon: CheckCircle2 },
                ].map((item, i) => (
                  <div key={i} className="flex items-center gap-3 px-5 py-3.5">
                    <item.icon className={`h-3.5 w-3.5 ${item.statusColor} shrink-0`} />
                    <span className="text-[0.8125rem] text-[#EDE8D0]/70 flex-1 truncate">{item.name}</span>
                    <span className={`text-[0.6875rem] font-medium ${item.statusColor}`}>{item.status}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Card 4 – Branches (bottom-left) */}
            <div className="absolute bottom-16 left-0 w-[220px] glass-panel rounded-2xl p-5 z-10 animate-float-4">
              <div className="flex items-center gap-2.5 mb-3">
                <GitBranch className="h-3.5 w-3.5 text-[#EDE8D0]/50" />
                <p className="text-[0.8125rem] font-semibold text-[#EDE8D0]/80 tracking-[-0.01em]">Branches</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full bg-[#EDE8D0]/[0.08] border border-[#EDE8D0]/[0.06] px-3 py-1.5 text-[0.6875rem] font-medium text-[#EDE8D0]/70">
                  feat/auth-flow
                </span>
                <span className="rounded-full bg-white/[0.04] border border-white/[0.06] px-3 py-1.5 text-[0.6875rem] font-medium text-[#EDE8D0]/35">
                  fix/api-routes
                </span>
              </div>
            </div>

            {/* Card 5 – Stats (bottom-right) */}
            <div className="absolute bottom-4 right-8 w-[200px] glass-panel rounded-2xl p-5 z-30 animate-float-5">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-[#EDE8D0]/[0.08] border border-[#EDE8D0]/[0.05] flex items-center justify-center">
                  <Send className="h-4 w-4 text-[#EDE8D0]/60" />
                </div>
                <div>
                  <p className="text-2xl font-bold text-[#EDE8D0]/90 tracking-[-0.03em] leading-none">3 PRs</p>
                  <p className="text-[0.6875rem] text-[#EDE8D0]/30 mt-1">merged today</p>
                </div>
              </div>
            </div>

            {/* Card 6 – Review (mid-right) */}
            <div className="absolute top-[280px] right-[-10px] w-[240px] glass-panel rounded-2xl p-5 z-30 animate-float-2" style={{ animationDelay: '1s' }}>
              <div className="flex items-center gap-2.5 mb-3.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-[#EDE8D0]/50" />
                <p className="text-[0.8125rem] font-semibold text-[#EDE8D0]/80 tracking-[-0.01em]">Review</p>
              </div>
              <div className="flex gap-2">
                <span className="rounded-lg bg-[#EDE8D0]/90 text-[#161820] px-3.5 py-2 text-[0.6875rem] font-semibold shadow-lg shadow-[#EDE8D0]/10">
                  Approve
                </span>
                <span className="rounded-lg bg-white/[0.04] border border-white/[0.06] px-3.5 py-2 text-[0.6875rem] font-medium text-[#EDE8D0]/35">
                  Request changes
                </span>
              </div>
            </div>

          </div>
        </div>
      </div>
    </section>
  )
}
