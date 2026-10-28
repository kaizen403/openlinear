"use client"

import { Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSearchParams } from "next/navigation"
import { BookOpen, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { focusRing } from "@/components/ui/focus-ring"
import { KnowledgeForm } from "@/components/knowledge/knowledge-form"
import { KnowledgeList, type KnowledgeTab } from "@/components/knowledge/knowledge-list"
import { describeApiError } from "@/lib/api/errors"
import { fetchProjectKnowledge, type KnowledgeEntry } from "@/lib/api/knowledge"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-13: a project's knowledge (W19b). What the team wants every agent run
 * to know: active entries go into each run's first prompt (conventions
 * first, bounded); agents can only propose, people approve.
 */

type Editing = { kind: "new" } | { kind: "edit"; entry: KnowledgeEntry } | null

const TABS: Array<{ value: KnowledgeTab; label: string }> = [
  { value: "active", label: "Active" },
  { value: "proposed", label: "Proposed" },
  { value: "retracted", label: "Retracted" },
]

function ProjectKnowledgeContent() {
  const searchParams = useSearchParams()
  const projectId = searchParams.get("id")
  const projectName = searchParams.get("name") || "Project"
  const client = useAppQueryClient()
  const [editing, setEditing] = useState<Editing>(null)
  const [tab, setTab] = useState<KnowledgeTab>("active")
  const knowledge = useQuery({
    queryKey: queryKeys.knowledge.list(projectId ?? ""),
    queryFn: () => fetchProjectKnowledge(projectId ?? ""),
    enabled: projectId !== null,
  }, client)

  if (!projectId) {
    return <EmptyState icon={BookOpen} title="No project selected" description="Select a project from the sidebar" />
  }
  const entries = knowledge.data ?? []
  const count = (status: KnowledgeTab) => entries.filter((entry) => entry.status === status).length

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-3" data-tauri-drag-region>
        <BookOpen className="w-5 h-5 text-linear-text-secondary flex-shrink-0" />
        <h1 className="text-lg font-semibold truncate">{projectName} · Knowledge</h1>
        <div className="flex-1 h-full" data-tauri-drag-region />
        {editing === null && (
          <Button size="sm" variant="outline" onClick={() => setEditing({ kind: "new" })}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            New entry
          </Button>
        )}
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto bg-linear-bg">
        {editing !== null ? (
          <div className="mx-auto max-w-2xl p-4 sm:p-6">
            <KnowledgeForm
              projectId={projectId}
              entry={editing.kind === "edit" ? editing.entry : undefined}
              onCancel={() => setEditing(null)}
              onSaved={() => setEditing(null)}
            />
          </div>
        ) : knowledge.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((index) => <Skeleton key={index} className="h-16 w-full rounded" />)}</div>
        ) : knowledge.isError ? (
          <p role="alert" className="p-6 text-sm text-linear-text-secondary">{describeApiError(knowledge.error, "Couldn't load the knowledge.").message}</p>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No knowledge yet"
            description="Write down what every agent working on this project should know: conventions, procedures, pitfalls. Active entries go into each run's first prompt. Agents can propose entries; you approve them."
          />
        ) : (
          <>
            <p className="border-b border-linear-border px-4 py-2 text-[12px] text-linear-text-secondary sm:px-6">
              Every run in this project gets the active, unexpired entries (conventions first, up to 20 entries or 8,000 characters).
            </p>
            <div role="tablist" aria-label="Status" className="flex gap-1 border-b border-linear-border px-4 py-2 sm:px-6">
              {TABS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.value}
                  onClick={() => setTab(item.value)}
                  className={cn("h-7 rounded-sm px-2.5 text-xs", tab === item.value ? "bg-foreground/10 text-linear-text" : "text-linear-text-secondary hover:text-linear-text", focusRing)}
                >
                  {item.label} <span className="text-linear-text-tertiary">{count(item.value)}</span>
                </button>
              ))}
            </div>
            <KnowledgeList entries={entries} tab={tab} onEdit={(entry) => setEditing({ kind: "edit", entry })} />
          </>
        )}
      </div>
    </>
  )
}

export default function ProjectKnowledgePage() {
  return (
    <Suspense fallback={<div className="flex-1 bg-linear-bg" />}>
      <ProjectKnowledgeContent />
    </Suspense>
  )
}
