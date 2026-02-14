import { Header } from "@/components/header"
import { Footer } from "@/components/footer"
import { ArrowRight } from "lucide-react"

export default function EnterprisePage() {
  return (
    <main>
      <Header />

      <section className="relative pt-40 pb-32 overflow-hidden">
        <div className="absolute inset-0 bg-[#161820]" />
        <div className="absolute top-0 right-0 w-3/4 h-full bg-[radial-gradient(ellipse_60%_70%_at_80%_25%,hsl(45_20%_18%/0.2),transparent_65%)]" />
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[hsl(0_0%_100%/0.04)] to-transparent" />
        <div className="relative mx-auto max-w-none px-[100px]">
          <h1 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-[#EDE8D0] text-balance leading-[1.04]">
            AI execution with control.
          </h1>
          <p className="text-[#EDE8D0]/40 leading-[1.75] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-6">
            OpenLinear gives engineering teams a controlled environment for AI-powered code execution. Every action is transparent, every change is reviewable.
          </p>
        </div>
      </section>

      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Local-first architecture
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            OpenLinear runs entirely on your infrastructure. No code leaves your network unless you choose to push to GitHub.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "Desktop application with local API sidecar",
              "PostgreSQL database on your machine",
              "No cloud processing of source code",
              "Full control over agent execution environment",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Repository isolation
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            Each task executes in its own isolated git worktree. Tasks cannot interfere with each other or with your working directory.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "Isolated worktrees per task",
              "Independent branches",
              "No shared state between executions",
              "Clean rollback on failure",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Configurable limits
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            Control how many tasks run simultaneously, how batches behave, and what happens on failure.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "Parallel execution limit (default: 3)",
              "Max batch size control",
              "Stop-on-failure option",
              "Merge conflict behavior (skip or fail)",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Transparent execution logs
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            Every agent action is streamed in real-time. See tool calls, file edits, and decisions as they happen. Full audit trail for every task.
          </p>
        </div>
      </section>

      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Future: self-hosted options
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            We&apos;re working on fully self-hosted deployment options for teams that need complete infrastructure control.
          </p>
        </div>
      </section>

      <section className="relative py-32 md:py-40 overflow-hidden">
        <div className="absolute inset-0 bg-[#161820]" />
        <div className="absolute top-0 right-0 w-3/4 h-full bg-[radial-gradient(ellipse_60%_70%_at_80%_25%,hsl(45_20%_18%/0.2),transparent_65%)]" />
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[hsl(0_0%_100%/0.04)] to-transparent" />
        <div className="relative mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-[#EDE8D0] text-balance leading-[1.04]">
            Ready to evaluate?
          </h2>
          <a
            href="/contact"
            className="inline-flex items-center gap-2.5 rounded-full border border-[#EDE8D0]/[0.06] px-7 py-3 text-[0.8125rem] font-medium text-[#EDE8D0]/70 transition-all duration-[300ms] hover:bg-[#EDE8D0]/[0.03] hover:border-[#EDE8D0]/[0.1] w-fit mt-8"
          >
            Contact Sales <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </section>

      <Footer />
    </main>
  )
}
