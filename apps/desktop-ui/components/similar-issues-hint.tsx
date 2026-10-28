"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Copy } from "lucide-react"
import { STATUS_COLORS } from "@/lib/design-tokens"
import { fetchSimilarTasks } from "@/lib/api/task-dependencies"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-11: while a title is typed, open issues in the project that look the
 * same. A hint only — it never blocks creating or merges anything.
 */

export const MIN_SIMILAR_TITLE = 6
const DEBOUNCE_MS = 300

export function SimilarIssuesHint({ projectId, title }: { projectId: string | null | undefined; title: string }) {
  const client = useAppQueryClient()
  const [debounced, setDebounced] = useState(title.trim())
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(title.trim()), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [title])
  const enabled = Boolean(projectId) && debounced.length >= MIN_SIMILAR_TITLE
  const similar = useQuery({
    queryKey: ["ol", "project", projectId ?? "", "similar-tasks", debounced],
    queryFn: () => fetchSimilarTasks(projectId ?? "", debounced),
    enabled,
    staleTime: 30_000,
    retry: false,
  }, client)
  const items = enabled ? similar.data ?? [] : []
  if (items.length === 0) return null
  return (
    <div className="mt-2 rounded-sm border border-linear-border bg-linear-bg-secondary px-2.5 py-2" role="note" aria-label="Similar issues">
      <p className="mb-1 flex items-center gap-1.5 text-[11px] text-linear-text-tertiary">
        <Copy className="h-3 w-3" aria-hidden="true" />
        Similar issues in this project — check it isn't a duplicate:
      </p>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-xs">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", STATUS_COLORS[item.status].dot)} aria-hidden="true" />
            {item.identifier && <span className="shrink-0 font-mono text-[11px] text-linear-text-tertiary">{item.identifier}</span>}
            <span className="truncate text-linear-text-secondary">{item.title}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
