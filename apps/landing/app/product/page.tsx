import { Header } from "@/components/header"
import { Footer } from "@/components/footer"

export default function ProductPage() {
  return (
    <main>
      <Header />

      {/* Hero */}
      <section className="relative bg-background pt-40 pb-20">
        <div className="mx-auto max-w-none px-[100px]">
          <span className="text-[0.75rem] font-semibold text-primary/60 mb-5 tracking-[-0.01em] block">
            Product
          </span>
          <h1 className="font-display text-[2rem] md:text-[2.75rem] lg:text-[3.25rem] font-bold tracking-[-0.045em] text-foreground text-balance leading-[1.04] mt-5">
            A board that executes.
          </h1>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-6">
            OpenLinear is a desktop kanban board connected to your GitHub repository. Tasks don't just get tracked — they get done by AI agents.
          </p>
        </div>
      </section>

      {/* Overview */}
      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Overview
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            OpenLinear combines task management with AI-powered code execution. Create tasks, organize them on a kanban board, and run AI agents that implement changes directly in your repository.
          </p>
          <div className="grid md:grid-cols-3 gap-8 mt-14">
            {[
              {
                title: "Task Board",
                description: "Kanban-style board with drag-and-drop. Create tasks with titles, descriptions, labels, and priorities.",
              },
              {
                title: "Execution Engine",
                description: "Click Execute and an AI agent clones your repo, creates a branch, and implements the task autonomously.",
              },
              {
                title: "Pull Requests",
                description: "Every completed task produces a real pull request on GitHub. Review, approve, and merge as usual.",
              },
            ].map((item) => (
              <div key={item.title} className="mock-card rounded-2xl p-8 lg:p-10">
                <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">
                  {item.title}
                </h3>
                <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em]">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Task Model */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Task model
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            Tasks in OpenLinear are lightweight and structured.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "Title and description",
              "Labels for categorization",
              "Status: Backlog, Todo, In Progress, Done",
              "Priority levels: Urgent, High, Medium, Low",
              "Linked pull requests after execution",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Execution Engine */}
      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Execution engine
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            When you execute a task, OpenLinear:
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "Clones your repository into an isolated worktree",
              "Creates a dedicated branch",
              "Starts an AI agent session with your task description",
              "Streams real-time progress to the UI",
              "Commits changes and creates a pull request",
            ].map((bullet, i) => (
              <li key={i} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Batch System */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Batch system
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            Execute multiple tasks at once. Choose between parallel and queue modes.
          </p>
          <div className="grid lg:grid-cols-2 gap-14 mt-14">
            <div>
              <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">
                Parallel mode
              </h3>
              <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em]">
                Run multiple tasks simultaneously. Configurable concurrency limit. When a slot frees up, the next task starts automatically.
              </p>
            </div>
            <div>
              <h3 className="font-display text-[1.25rem] font-bold tracking-[-0.03em] text-foreground mb-3">
                Queue mode
              </h3>
              <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em]">
                Run tasks one at a time, sequentially. Optionally require approval before starting the next task.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* GitHub Integration */}
      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            GitHub integration
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            OpenLinear connects directly to your GitHub repositories.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "Automatic branch creation",
              "Pull request generation",
              "Merge conflict detection",
              "Batched PRs from multiple tasks",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Desktop Architecture */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Desktop architecture
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            OpenLinear runs as a desktop application with a local API sidecar. The sidecar manages repository operations, agent sessions, and database state. No cloud dependency for execution.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "Electron-based desktop app",
              "Local PostgreSQL database",
              "API sidecar for agent management",
              "SSE streaming for real-time updates",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Supported Platforms */}
      <section className="relative py-32 md:py-40 bg-[#1a1c26]">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Supported platforms
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            Currently available for macOS and Linux. Windows support is planned.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "macOS — DMG installer",
              "Linux — AppImage and .deb packages",
              "AUR package for Arch Linux",
              "CLI installer via npm",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Roadmap */}
      <section className="relative py-32 md:py-40 bg-background">
        <div className="absolute top-0 left-0 right-0 section-divider" />
        <div className="mx-auto max-w-none px-[100px]">
          <h2 className="font-display text-[1.625rem] md:text-[2rem] font-bold tracking-[-0.04em] text-foreground">
            Roadmap
          </h2>
          <p className="text-muted-foreground/65 leading-[1.7] text-[0.9375rem] tracking-[-0.01em] max-w-xl mt-5">
            OpenLinear is actively developed. Here&apos;s what&apos;s next.
          </p>
          <ul className="flex flex-col gap-4 mt-8">
            {[
              "More AI agents (Claude Code, Codex, Aider)",
              "Better batch visibility and controls",
              "Windows support",
              "Team collaboration features",
            ].map((bullet) => (
              <li key={bullet} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                {bullet}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <Footer />
    </main>
  )
}
