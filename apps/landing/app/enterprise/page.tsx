import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ArrowRight, Shield, GitBranch, Eye, Cpu, Layers, Lock } from "lucide-react"

export default function EnterprisePage() {
  return (
    <main>
      <Header />

      {/* ── Bold Enterprise Hero ─────────────────────── */}
      <section className="relative min-h-[85svh] flex items-center overflow-hidden">
        <div className="absolute inset-0 bg-[#161820]" />

        {/* Atmospheric glows */}
        <div className="absolute top-[-15%] left-[20%] w-[800px] h-[600px] rounded-full bg-[hsl(270_40%_25%/0.15)] blur-[180px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[15%] w-[600px] h-[500px] rounded-full bg-[hsl(45_30%_25%/0.12)] blur-[160px] pointer-events-none" />

        {/* Subtle grid */}
        <div className="absolute inset-0 opacity-[0.02]" style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: '80px 80px'
        }} />

        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

        <div className="relative mx-auto max-w-none px-[100px] w-full text-center py-40">
          <span className="hero-reveal-1 inline-block text-[0.75rem] font-semibold text-[#EDE8D0]/40 tracking-[0.2em] uppercase mb-8">
            Enterprise
          </span>
          <h1 className="hero-reveal-2 font-display text-[2.75rem] md:text-[3.75rem] lg:text-[4.5rem] font-bold tracking-[-0.05em] text-[#EDE8D0] leading-[1.02] max-w-4xl mx-auto">
            AI execution with{" "}
            <span className="bg-gradient-to-r from-[#EDE8D0] to-[#EDE8D0]/60 bg-clip-text text-transparent">
              enterprise control.
            </span>
          </h1>
          <p className="hero-reveal-3 text-[#EDE8D0]/40 leading-[1.75] text-[1.0625rem] tracking-[-0.01em] max-w-2xl mx-auto mt-8">
            Modernize your development workflow with AI-powered code execution.
            Every action transparent. Every change reviewable. Your infrastructure.
          </p>
          <div className="hero-reveal-4 flex items-center justify-center gap-4 mt-10">
            <a
              href="/contact"
              className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-8 py-3.5 text-[0.875rem] font-medium text-primary-foreground"
            >
              Contact Sales <ArrowRight className="h-3.5 w-3.5" />
            </a>
            <a
              href="/pricing"
              className="btn-secondary inline-flex items-center gap-2 rounded-full border border-[#EDE8D0]/[0.08] bg-[#EDE8D0]/[0.03] px-8 py-3.5 text-[0.875rem] font-medium text-[#EDE8D0]/70"
            >
              View Plans
            </a>
          </div>
        </div>
      </section>

      {/* ── Stats Strip ──────────────────────────────── */}
      <section className="relative py-20 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-10 lg:gap-16">
            {[
              { value: "100%", label: "Local execution", sub: "No code leaves your network" },
              { value: "3+", label: "Parallel agents", sub: "Configurable concurrency" },
              { value: "0", label: "Cloud dependencies", sub: "Fully self-contained" },
              { value: "∞", label: "Audit trail", sub: "Every action logged" },
            ].map((stat) => (
              <div key={stat.label} className="text-center lg:text-left">
                <p className="font-display text-[2.5rem] md:text-[3rem] font-bold tracking-[-0.04em] text-[#EDE8D0] leading-none">
                  {stat.value}
                </p>
                <p className="text-[0.875rem] font-medium text-[#EDE8D0]/70 mt-2 tracking-[-0.01em]">
                  {stat.label}
                </p>
                <p className="text-[0.75rem] text-[#EDE8D0]/30 mt-1">
                  {stat.sub}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Why Teams Choose OpenLinear ───────────────── */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="text-center mb-16">
            <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[0.15em] uppercase mb-4 block">
              Why OpenLinear
            </span>
            <h2 className="font-display text-[1.625rem] md:text-[2rem] lg:text-[2.5rem] font-bold tracking-[-0.04em] text-foreground">
              Built for engineering teams that need control
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-6 lg:gap-8">
            {[
              {
                icon: Shield,
                title: "Local-first architecture",
                description: "OpenLinear runs entirely on your infrastructure. No code leaves your network unless you choose to push to GitHub. Desktop app with local API sidecar and PostgreSQL.",
              },
              {
                icon: GitBranch,
                title: "Repository isolation",
                description: "Each task executes in its own isolated git worktree. Tasks cannot interfere with each other or with your working directory. Clean rollback on failure.",
              },
              {
                icon: Eye,
                title: "Transparent execution",
                description: "Every agent action is streamed in real-time. See tool calls, file edits, and decisions as they happen. Full audit trail for every task execution.",
              },
            ].map((item) => (
              <div key={item.title} className="mock-card rounded-2xl p-8 lg:p-10 group">
                <div className="h-12 w-12 rounded-xl bg-primary/[0.06] border border-primary/[0.08] flex items-center justify-center mb-6 group-hover:bg-primary/[0.1] transition-colors duration-300">
                  <item.icon className="h-5 w-5 text-primary/70" />
                </div>
                <h3 className="font-display text-[1.125rem] font-bold tracking-[-0.03em] text-foreground mb-3">
                  {item.title}
                </h3>
                <p className="text-muted-foreground/55 leading-[1.7] text-[0.875rem] tracking-[-0.01em]">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How It Delivers Value ─────────────────────── */}
      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="mb-16">
            <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[0.15em] uppercase mb-4 block">
              How It Works
            </span>
            <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground max-w-xl">
              Enterprise-grade execution in three steps
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-12 lg:gap-16">
            {[
              {
                step: "01",
                icon: Layers,
                title: "Configure",
                description: "Set parallel execution limits, batch behavior, merge conflict handling, and agent preferences. Control exactly how AI operates on your codebase.",
              },
              {
                step: "02",
                icon: Cpu,
                title: "Execute",
                description: "Tasks run in isolated worktrees with independent branches. No shared state between executions. Real-time streaming of all agent activity.",
              },
              {
                step: "03",
                icon: Lock,
                title: "Review & Ship",
                description: "Every completed task produces a real pull request. Review diffs, approve changes, and merge through your existing GitHub workflow.",
              },
            ].map((item) => (
              <div key={item.step} className="relative">
                <span className="text-[0.75rem] font-semibold text-primary/50 tracking-[-0.01em] mb-5 block font-mono">
                  {item.step}
                </span>
                <div className="h-10 w-10 rounded-lg bg-[#EDE8D0]/[0.05] border border-[#EDE8D0]/[0.06] flex items-center justify-center mb-5">
                  <item.icon className="h-4.5 w-4.5 text-[#EDE8D0]/60" />
                </div>
                <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">
                  {item.title}
                </h3>
                <p className="text-muted-foreground/55 leading-[1.7] text-[0.875rem] tracking-[-0.01em]">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Future: Self-Hosted ───────────────────────── */}
      <section className="relative py-24 md:py-28 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="flex flex-col lg:flex-row items-start lg:items-center gap-8 lg:gap-16">
            <div className="flex-1">
              <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[0.15em] uppercase mb-4 block">
                Coming Soon
              </span>
              <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
                Self-hosted deployment
              </h2>
              <p className="text-muted-foreground/55 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-lg mt-4">
                We&apos;re building fully self-hosted deployment options for teams that need complete infrastructure control. Run OpenLinear entirely within your own environment.
              </p>
            </div>
            <a
              href="/contact"
              className="btn-secondary inline-flex items-center gap-2 rounded-full border border-border/50 bg-background px-7 py-3 text-[0.875rem] font-medium text-foreground/80 whitespace-nowrap"
            >
              Join the waitlist <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </div>
      </section>

      {/* ── Enterprise CTA ───────────────────────────── */}
      <section className="relative py-32 md:py-40 overflow-hidden">
        <div className="absolute inset-0 bg-[#161820]" />
        <div className="absolute top-0 right-0 w-3/4 h-full bg-[radial-gradient(ellipse_60%_70%_at_80%_25%,hsl(270_30%_20%/0.15),transparent_65%)]" />
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[hsl(0_0%_100%/0.04)] to-transparent" />

        <div className="relative mx-auto max-w-none px-[100px] text-center">
          <h2 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-[#EDE8D0] text-balance leading-[1.04] max-w-2xl mx-auto">
            Ready to evaluate?
          </h2>
          <p className="text-[#EDE8D0]/35 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-lg mx-auto mt-5">
            Talk to our team about how OpenLinear can fit your engineering workflow.
          </p>
          <div className="flex items-center justify-center gap-4 mt-10">
            <a
              href="/contact"
              className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-8 py-3.5 text-[0.875rem] font-medium text-primary-foreground"
            >
              Contact Sales <ArrowRight className="h-3.5 w-3.5" />
            </a>
            <a
              href="/pricing"
              className="inline-flex items-center gap-2.5 rounded-full border border-[#EDE8D0]/[0.06] px-7 py-3.5 text-[0.8125rem] font-medium text-[#EDE8D0]/60 transition-all duration-300 hover:bg-[#EDE8D0]/[0.03] hover:border-[#EDE8D0]/[0.1]"
            >
              View Plans
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
