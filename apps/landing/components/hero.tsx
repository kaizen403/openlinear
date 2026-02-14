"use client"

import { ArrowRight, GitBranch, Clock, Sparkles, Send, CheckCircle2 } from "lucide-react"

export function Hero() {
  return (
    <section className="relative min-h-[100svh] flex items-center overflow-hidden">
      {/* Layer 0 - base */}
      <div className="absolute inset-0 bg-background" />

      {/* Layer 1 - atmospheric wash */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_120%_60%_at_50%_-10%,hsl(235_18%_95%/0.5),transparent_70%)] dark:bg-[radial-gradient(ellipse_120%_60%_at_50%_-10%,hsl(235_30%_15%/0.5),transparent_70%)]" />

      {/* Layer 2 - depth plane left */}
      <div className="absolute top-[20%] left-[8%] w-[600px] h-[600px] rounded-full bg-[hsl(235_20%_94%/0.25)] dark:bg-[hsl(235_30%_18%/0.2)] blur-[180px] pointer-events-none" />

      {/* Layer 3 - depth plane right */}
      <div className="absolute bottom-[5%] right-[5%] w-[500px] h-[500px] rounded-full bg-[hsl(220_22%_94%/0.2)] dark:bg-[hsl(243_25%_20%/0.15)] blur-[160px] pointer-events-none" />

      {/* Layer 4 - center light */}
      <div className="absolute top-[35%] left-[55%] -translate-x-1/2 -translate-y-1/2 w-[800px] h-[600px] rounded-full bg-[hsl(243_20%_96%/0.15)] dark:bg-[hsl(243_30%_22%/0.1)] blur-[200px] pointer-events-none" />

      {/* Layer 5 - horizon line */}
      <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[hsl(228_10%_88%/0.3)] dark:via-[hsl(228_10%_25%/0.3)] to-transparent" />

      <div className="relative mx-auto max-w-[76rem] px-6 lg:px-10 pt-40 pb-36 w-full">
        <div className="grid lg:grid-cols-2 gap-20 lg:gap-24 items-center">
          {/* Copy */}
          <div className="flex flex-col gap-8">
            <h1 className="font-display text-[2.75rem] md:text-[3.75rem] lg:text-[4.5rem] font-bold tracking-[-0.05em] text-foreground leading-[1.02]">
              <span className="text-balance">
                Execute your tasks.{" "}
                <br />
                <span className="text-primary/90">Don&apos;t just track them.</span>
              </span>
            </h1>
            <p className="text-[1.0625rem] text-muted-foreground/70 max-w-[22rem] leading-[1.7] tracking-[-0.01em]">
              OpenLinear is a desktop kanban board that runs AI coding agents on your GitHub repository. Create tasks, execute them, and review real pull requests — all from one place.
            </p>
            <div className="flex flex-wrap items-center gap-3.5 pt-1">
              <a
                href="#"
                className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-7 py-3 text-[0.875rem] font-medium text-primary-foreground"
              >
                Download for macOS <ArrowRight className="h-3.5 w-3.5" />
              </a>
              <a
                href="#"
                className="btn-secondary inline-flex items-center gap-2 rounded-full border border-border/50 bg-background px-7 py-3 text-[0.875rem] font-medium text-foreground/80"
              >
                View on GitHub
              </a>
            </div>
          </div>

          {/* Floating cards */}
          <div className="relative h-[540px] hidden lg:block">
            {/* Ambient glow behind card cluster */}
            <div className="absolute inset-[-60px] bg-[radial-gradient(circle_at_50%_45%,hsl(240_18%_95%/0.3),transparent_60%)] dark:bg-[radial-gradient(circle_at_50%_45%,hsl(243_30%_20%/0.2),transparent_60%)] pointer-events-none" />

            {/* Ground shadow */}
            <div className="absolute bottom-2 left-[12%] right-[12%] h-20 bg-[radial-gradient(ellipse_at_center,hsl(228_15%_88%/0.15),transparent_70%)] dark:bg-[radial-gradient(ellipse_at_center,hsl(228_15%_8%/0.3),transparent_70%)] blur-3xl pointer-events-none" />

            {/* Card 1 - AI Agent (back-left) */}
            <div className="animate-float-1 absolute top-2 left-0 max-w-[265px] glass-card rounded-2xl px-5 py-4 z-10">
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded-lg bg-primary/[0.05] flex items-center justify-center shrink-0">
                  <Sparkles className="h-3.5 w-3.5 text-primary/60" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.8125rem] font-medium text-foreground/90 tracking-[-0.01em]">AI Agent</p>
                  <p className="text-[0.75rem] text-muted-foreground/50 leading-[1.55]">
                    {"Task 'Add dark mode toggle' is being implemented. Creating branch and running agent..."}
                  </p>
                </div>
              </div>
            </div>

            {/* Card 2 - PR Created (front-right) */}
            <div className="animate-float-2 absolute top-20 right-0 max-w-[245px] glass-card rounded-2xl px-5 py-4 z-30">
              <div className="flex items-center gap-2.5 mb-2.5">
                <Send className="h-3.5 w-3.5 text-primary/50" />
                <p className="text-[0.8125rem] font-medium text-foreground/90 tracking-[-0.01em]">PR Created</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <p className="text-[0.75rem] font-medium text-foreground/80">feat: add dark mode toggle</p>
                <p className="text-[0.6875rem] text-muted-foreground/40 leading-[1.55]">
                  {"Branch feature/dark-mode ready for review"}
                </p>
              </div>
            </div>

            {/* Card 3 - Branches (mid-left) */}
            <div className="animate-float-3 absolute bottom-40 left-4 max-w-[215px] glass-card rounded-2xl px-5 py-4 z-20">
              <div className="flex items-center gap-2.5 mb-3">
                <GitBranch className="h-3.5 w-3.5 text-primary/50" />
                <p className="text-[0.8125rem] font-medium text-foreground/90 tracking-[-0.01em]">Branches</p>
              </div>
              <div className="flex gap-2">
                <span className="rounded-full bg-primary/[0.06] px-3 py-1.5 text-[0.6875rem] font-medium text-primary/80">
                  feat/auth-flow
                </span>
                <span className="rounded-full bg-muted/60 px-3 py-1.5 text-[0.6875rem] font-medium text-muted-foreground/50">
                  fix/api-routes
                </span>
              </div>
            </div>

            {/* Card 4 - Review (front-right-bottom) */}
            <div className="animate-float-4 absolute bottom-8 right-4 max-w-[230px] glass-card rounded-2xl px-5 py-4 z-30">
              <div className="flex items-center gap-2.5 mb-3">
                <CheckCircle2 className="h-3.5 w-3.5 text-primary/50" />
                <p className="text-[0.8125rem] font-medium text-foreground/90 tracking-[-0.01em]">Review</p>
              </div>
              <div className="flex gap-2">
                <span className="rounded-lg bg-primary/90 text-primary-foreground px-3 py-1.5 text-[0.6875rem] font-medium">
                  {"Approve"}
                </span>
                <span className="rounded-lg bg-muted/60 px-3 py-1.5 text-[0.6875rem] font-medium text-muted-foreground/50">
                  {"Request changes"}
                </span>
              </div>
            </div>

            {/* Card 5 - PRs merged (center) */}
            <div className="animate-float-5 absolute top-[215px] left-[110px] max-w-[155px] glass-card rounded-2xl px-5 py-4 z-20">
              <div className="flex items-center gap-3">
                <Clock className="h-4 w-4 text-primary/50" />
                <div>
                  <p className="text-xl font-bold text-foreground/90 tracking-[-0.03em]">3 PRs</p>
                  <p className="text-[0.6875rem] text-muted-foreground/40">merged today</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
