"use client"

import { ArrowRight, Blocks, Compass } from "lucide-react"

interface FeatureData {
  eyebrow: string
  icon: React.ElementType
  headline: string
  description: string
  link: { label: string; href: string }
  bullets: string[]
  mockContent: {
    title: string
    rows: { label: string; detail: string }[]
  }
  reversed?: boolean
  bg: string
}

const features: FeatureData[] = [
  {
    eyebrow: "Built for Developers",
    icon: Blocks,
    headline: "Desktop-first. Developer-focused.",
    description:
      "OpenLinear runs locally on your machine. No browser tabs, no SaaS dependencies for execution.",
    link: { label: "View on GitHub", href: "#" },
    bullets: [
      "Desktop-first execution",
      "Local or controlled environment",
      "GitHub integration",
      "Real-time board updates",
      "Configurable parallel limits",
      "Batch execution (parallel or queue)",
    ],
    mockContent: {
      title: "Board",
      rows: [
        { label: "Add auth flow", detail: "Priority: High · Status: In Progress" },
        { label: "Fix API routes", detail: "Priority: Medium · Status: Queued" },
        { label: "Update README", detail: "Priority: Low · Status: Done" },
        { label: "Dark mode toggle", detail: "Priority: Medium · Status: Executing" },
      ],
    },
    reversed: false,
    bg: "bg-background",
  },
  {
    eyebrow: "Batch Execution",
    icon: Compass,
    headline: "Run tasks alone — or together.",
    description:
      "Select multiple tasks and execute them in parallel or queue mode. Each task runs in its own branch. Merge into a single pull request when ready.",
    link: { label: "Learn more", href: "#" },
    bullets: [
      "Parallel execution with configurable limits",
      "Queue mode with auto-approve",
      "Isolated git worktrees per task",
      "Single batched pull request",
    ],
    mockContent: {
      title: "Batch Queue",
      rows: [
        { label: "feat/auth-flow", detail: "Executing · Agent running" },
        { label: "fix/api-routes", detail: "Queued · Waiting for slot" },
        { label: "feat/dark-mode", detail: "Completed · PR #142 created" },
        { label: "docs/readme-update", detail: "Completed · PR #141 created" },
      ],
    },
    reversed: true,
    bg: "bg-[hsl(228_14%_97.5%)]",
  },
]

function FeatureMock({ content }: { content: FeatureData["mockContent"] }) {
  return (
    <div className="mock-card rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 border-b border-border/30">
        <div className="flex gap-[5px]">
          <div className="h-2 w-2 rounded-full bg-foreground/[0.05]" />
          <div className="h-2 w-2 rounded-full bg-foreground/[0.03]" />
          <div className="h-2 w-2 rounded-full bg-foreground/[0.03]" />
        </div>
        <p className="text-[0.6875rem] text-muted-foreground/40 tracking-[-0.01em]">{content.title}</p>
      </div>
      <div className="divide-y divide-border/8">
        {content.rows.map((row, i) => (
          <div key={i} className="flex items-center gap-3.5 px-6 py-4 transition-colors duration-[250ms] hover:bg-muted/15">
            <div className={`h-8 w-8 rounded-full shrink-0 ${i === 0 ? "bg-primary/[0.04]" : "bg-muted/25"}`} />
            <div className="flex-1 min-w-0">
              <p className="text-[0.8125rem] font-medium text-foreground/85 tracking-[-0.01em]">{row.label}</p>
              <p className="text-[0.6875rem] text-muted-foreground/30 mt-0.5 truncate">{row.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FeatureSection({ feature }: { feature: FeatureData }) {
  const Icon = feature.icon

  return (
    <section className={`relative py-32 md:py-40 ${feature.bg}`}>
      <div className="absolute top-0 left-0 right-0 section-divider" />

      <div className="mx-auto max-w-[76rem] px-6 lg:px-10">
        <div className={`grid lg:grid-cols-2 gap-14 lg:gap-24 items-center ${feature.reversed ? "lg:[&>*:first-child]:order-2" : ""}`}>
          {/* Copy */}
          <div className="flex flex-col gap-6">
            <div>
              <span className="inline-flex items-center gap-2 text-[0.75rem] font-semibold text-primary/60 mb-5 tracking-[-0.01em]">
                <Icon className="h-3.5 w-3.5" />
                {feature.eyebrow}
              </span>
              <h3 className="font-display text-[1.5rem] md:text-[2rem] lg:text-[2.375rem] font-bold tracking-[-0.04em] text-foreground text-balance leading-[1.06]">
                {feature.headline}
              </h3>
            </div>
            <p className="text-muted-foreground/65 leading-[1.7] max-w-lg text-[0.9375rem] tracking-[-0.01em]">
              {feature.description}
            </p>
            <a
              href={feature.link.href}
              className="inline-flex items-center gap-2 text-[0.8125rem] font-medium text-primary/80 group transition-colors duration-250 hover:text-primary"
            >
              {feature.link.label}
              <ArrowRight className="h-3.5 w-3.5 transition-transform duration-[300ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)] group-hover:translate-x-1" />
            </a>
            <ul className="flex flex-col gap-4 pt-2">
              {feature.bullets.map((bullet, i) => (
                <li key={i} className="flex items-center gap-3 text-[0.875rem] text-muted-foreground/55 tracking-[-0.01em]">
                  <span className="h-[3px] w-[3px] rounded-full bg-foreground/10 shrink-0" />
                  {bullet}
                </li>
              ))}
            </ul>
          </div>

          {/* Mock */}
          <div>
            <FeatureMock content={feature.mockContent} />
          </div>
        </div>
      </div>
    </section>
  )
}

export function FeatureSections() {
  return (
    <>
      {features.map((feature) => (
        <FeatureSection key={feature.eyebrow} feature={feature} />
      ))}
    </>
  )
}
