"use client"

import { RemotionPlayerWrapper } from "@/components/remotion-player-wrapper"

const howItWorksLazy = () => import("@/remotion/HowItWorksAnimation")

export function HowItWorksSection() {
  return (
    <section className="py-20 md:py-24 px-6 md:px-20" style={{ fontFamily: "'Anthropic Sans', system-ui, sans-serif" }}>
      <div className="mx-auto max-w-content">
        <p className="text-[13px] text-label mb-10 tracking-wide uppercase">How it works</p>

        <ol className="space-y-8">
          <Step
            number={1}
            title="Create a task."
            description="Add it to your kanban board with a clear description. Tag it, prioritize it, assign labels."
          />
          <Step
            number={2}
            title="Hit execute."
            description="OpenLinear's AI agent clones your repo, creates a branch, and writes the implementation in an isolated workspace on your machine."
          />
          <Step
            number={3}
            title="Review & merge."
            description="Get a real pull request with production-quality code. Review the diff, request changes if needed, or merge directly."
          />
        </ol>

        <RemotionPlayerWrapper
          lazyComponent={howItWorksLazy}
          durationInFrames={450}
          fps={30}
          aspectRatio="16/9"
          className="mt-10 md:mt-14"
          style={{ borderRadius: "16px", border: "1px solid hsl(0 0% 14.9%)" }}
        />
      </div>
    </section>
  )
}

function Step({
  number,
  title,
  description,
}: {
  number: number
  title: string
  description: string
}) {
  return (
    <li className="flex gap-3 text-[16px] leading-[24px]">
      <span className="shrink-0 text-[24px] font-light tabular-nums text-blue-500 leading-[24px]">{number}</span>
      <p>
        <span className="font-semibold">{title}</span>
        <span className="text-muted-foreground">{" "}{description}</span>
      </p>
    </li>
  )
}
