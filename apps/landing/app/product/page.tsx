import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ArrowRight, LayoutGrid, Cpu, GitPullRequest, Layers, GitBranch, Monitor, Compass } from "lucide-react"

export default function ProductPage() {
  return (
    <main>
      <Header />

      {/* ── Hero ─────────────────────────────────── */}
      <section className="relative min-h-[85svh] flex items-center overflow-hidden">
        <div className="absolute inset-0 bg-[#161820]" />
        <div className="absolute top-[-10%] left-[40%] w-[700px] h-[500px] rounded-full bg-[hsl(45_30%_30%/0.12)] blur-[150px] pointer-events-none" />
        <div className="absolute bottom-[-10%] right-[20%] w-[500px] h-[400px] rounded-full bg-[hsl(220_50%_25%/0.15)] blur-[160px] pointer-events-none" />
        <div className="absolute inset-0 opacity-[0.02]" style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: '80px 80px'
        }} />
        <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-white/[0.06] to-transparent" />

        <div className="relative mx-auto max-w-none px-[100px] w-full text-center py-40">
          <span className="hero-reveal-1 inline-block text-[0.75rem] font-semibold text-[#EDE8D0]/40 tracking-[0.2em] uppercase mb-8">
            Product
          </span>
          <h1 className="hero-reveal-2 font-display text-[2.75rem] md:text-[3.75rem] lg:text-[4.5rem] font-bold tracking-[-0.05em] text-[#EDE8D0] leading-[1.02] max-w-3xl mx-auto">
            A board that executes
            <br />
            <span className="bg-gradient-to-r from-[#EDE8D0]/50 to-[#EDE8D0]/30 bg-clip-text text-transparent">
              and brainstorms.
            </span>
          </h1>
          <p className="hero-reveal-3 text-[#EDE8D0]/40 leading-[1.75] text-[1.0625rem] tracking-[-0.01em] max-w-2xl mx-auto mt-8">
            OpenLinear is a desktop kanban board connected to your GitHub repository.
            Tasks don&apos;t just get tracked — they get done by AI agents.
          </p>
          <div className="hero-reveal-4 flex items-center justify-center gap-4 mt-10">
            <a
              href="#"
              className="btn-primary inline-flex items-center gap-2.5 rounded-full bg-primary px-8 py-3.5 text-[0.875rem] font-medium text-primary-foreground"
            >
              Download for macOS <ArrowRight className="h-3.5 w-3.5" />
            </a>
            <a
              href="/docs"
              className="btn-secondary inline-flex items-center gap-2 rounded-full border border-[#EDE8D0]/[0.08] bg-[#EDE8D0]/[0.03] px-8 py-3.5 text-[0.875rem] font-medium text-[#EDE8D0]/70"
            >
              Read the docs
            </a>
          </div>
        </div>
      </section>

      {/* ── Core Features — 3 cards ──────────────── */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="text-center mb-16">
            <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[0.15em] uppercase mb-4 block">
              Overview
            </span>
            <h2 className="font-display text-[1.625rem] md:text-[2rem] lg:text-[2.5rem] font-bold tracking-[-0.04em] text-foreground">
              Three steps from task to pull request
            </h2>
          </div>

          <div className="grid md:grid-cols-3 gap-6 lg:gap-8">
            {[
              {
                icon: LayoutGrid,
                title: "Task Board",
                description: "Kanban-style board with drag-and-drop. Create tasks with titles, descriptions, labels, and priorities. Multi-select for batch operations.",
              },
              {
                icon: Cpu,
                title: "Execution Engine",
                description: "Click Execute and an AI agent clones your repo, creates a dedicated branch, and implements the task autonomously in an isolated worktree.",
              },
              {
                icon: GitPullRequest,
                title: "Pull Requests",
                description: "Every completed task produces a real pull request on GitHub. Review diffs, approve changes, and merge through your existing workflow.",
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

      {/* ── Capabilities — 2×2 Grid ──────────────── */}
      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="mb-16">
            <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[0.15em] uppercase mb-4 block">
              Capabilities
            </span>
            <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground max-w-xl">
              Everything you need for AI-powered development
            </h2>
          </div>

          <div className="grid md:grid-cols-2 gap-6 lg:gap-8">
            {[
              {
                icon: Layers,
                title: "Batch Execution",
                description: "Run multiple tasks simultaneously in parallel mode, or sequentially in queue mode. Configurable concurrency limits. All changes merge into a single batched pull request when ready.",
                details: ["Parallel + queue modes", "Configurable concurrency (default: 3)", "Single batched PR", "Auto-approve option"],
              },
              {
                icon: GitBranch,
                title: "GitHub Integration",
                description: "Connects directly to your GitHub repositories. Automatic branch creation, pull request generation, and merge conflict detection. Works with both public and private repos.",
                details: ["Automatic branches", "PR generation", "Conflict detection", "OAuth authentication"],
              },
              {
                icon: Monitor,
                title: "Desktop Architecture",
                description: "Runs as a desktop application with a local API sidecar. The sidecar manages repository operations, agent sessions, and database state. No cloud dependency for execution.",
                details: ["Electron desktop app", "Local PostgreSQL", "API sidecar", "SSE real-time streaming"],
              },
              {
                icon: Compass,
                title: "Multi-Platform Support",
                description: "Available for macOS and Linux with multiple installation options. Windows support is planned. CLI installer also available via npm.",
                details: ["macOS — DMG installer", "Linux — AppImage & .deb", "AUR (Arch Linux)", "npm CLI installer"],
              },
            ].map((item) => (
              <div key={item.title} className="mock-card rounded-2xl p-8 lg:p-10 group">
                <div className="flex items-start gap-5">
                  <div className="h-10 w-10 rounded-lg bg-[#EDE8D0]/[0.05] border border-[#EDE8D0]/[0.06] flex items-center justify-center shrink-0 group-hover:bg-[#EDE8D0]/[0.08] transition-colors duration-300">
                    <item.icon className="h-4 w-4 text-[#EDE8D0]/60" />
                  </div>
                  <div className="flex-1">
                    <h3 className="font-display text-[1.125rem] font-bold tracking-[-0.03em] text-foreground mb-2">
                      {item.title}
                    </h3>
                    <p className="text-muted-foreground/55 leading-[1.7] text-[0.8125rem] tracking-[-0.01em]">
                      {item.description}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-4">
                      {item.details.map((detail) => (
                        <span
                          key={detail}
                          className="inline-flex items-center rounded-full bg-[#EDE8D0]/[0.04] border border-[#EDE8D0]/[0.06] px-3 py-1 text-[0.6875rem] text-muted-foreground/50 font-medium"
                        >
                          {detail}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Roadmap ──────────────────────────────── */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <div className="text-center mb-16">
            <span className="text-[0.75rem] font-semibold text-primary/60 tracking-[0.15em] uppercase mb-4 block">
              Roadmap
            </span>
            <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
              What&apos;s next
            </h2>
            <p className="text-muted-foreground/55 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-lg mx-auto mt-4">
              OpenLinear is actively developed. Here&apos;s what we&apos;re working on.
            </p>
          </div>

          <div className="grid md:grid-cols-4 gap-6 max-w-4xl mx-auto">
            {[
              { label: "In Progress", title: "More AI agents", sub: "Claude Code, Codex, Aider" },
              { label: "In Progress", title: "Batch visibility", sub: "Better controls & monitoring" },
              { label: "Planned", title: "Windows support", sub: "Native desktop app" },
              { label: "Planned", title: "Team collaboration", sub: "Shared boards & roles" },
            ].map((item) => (
              <div key={item.title} className="mock-card rounded-xl p-6 text-center group">
                <span className={`inline-block text-[0.625rem] font-semibold tracking-[0.1em] uppercase mb-3 ${item.label === "In Progress" ? "text-green-400/70" : "text-muted-foreground/40"
                  }`}>
                  {item.label}
                </span>
                <h3 className="font-display text-[1rem] font-bold tracking-[-0.02em] text-foreground mb-1.5">
                  {item.title}
                </h3>
                <p className="text-muted-foreground/45 text-[0.75rem] leading-[1.6]">
                  {item.sub}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </main>
  )
}
