"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"
import { BarChart3 } from "lucide-react"
import { EmptyState } from "@/components/empty-state"
import { InsightsPanel } from "@/components/insights/insights-panel"

/**
 * W15b: a project's insights — agent run outcomes, verification, pull
 * requests, duration, cost (unknown prices counted, never guessed), runners
 * and models, and delivery (created vs completed, cycle time, blocked now,
 * plan approvals) over 7 / 30 / 90 days.
 */

function ProjectInsightsContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get("id")
  const projectName = searchParams.get("name") || "Project"

  if (!projectId) {
    return <EmptyState icon={BarChart3} title="No project selected" description="Select a project from the sidebar" />
  }

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-3" data-tauri-drag-region>
        <BarChart3 className="w-5 h-5 text-linear-text-secondary flex-shrink-0" aria-hidden="true" />
        <h1 className="text-lg font-semibold truncate">{projectName} · Insights</h1>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto bg-linear-bg">
        <div className="mx-auto max-w-7xl p-4 sm:p-6">
          <InsightsPanel key={projectId} scope={{ kind: "project", id: projectId }} />
        </div>
      </div>
    </>
  )
}

export default function ProjectInsightsPage() {
  return (
    <Suspense fallback={<div className="flex-1 bg-linear-bg" />}>
      <ProjectInsightsContent />
    </Suspense>
  )
}
