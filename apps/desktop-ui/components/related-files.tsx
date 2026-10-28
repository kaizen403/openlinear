"use client"

import { useQuery } from "@tanstack/react-query"
import { FileCode2 } from "lucide-react"
import { fetchRelatedFiles, type RelatedFile } from "@/lib/api/repo-context"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

/**
 * FE-11 / W16b: "Related files" in the task sidebar — files of the project's
 * repository on this device that share words with the task (the same ranking
 * the agent's prompt gets), with the line range and the matched words.
 * Suggestions only. Silent when there is nothing to show: no repository on
 * this device, turned off, the sidecar unreachable, or no match. While the
 * repository is being indexed it asks again after the sidecar's hint.
 */

const DEFAULT_RETRY_MS = 3_000

/** A short fingerprint of what the ranking reads, so edits to the task refetch. */
export function relatedFilesRevision(task: { title: string; description: string | null; labels: ReadonlyArray<{ name: string }> }): string {
  const text = `${task.title}\n${task.description ?? ""}\n${task.labels.map((label) => label.name).join("\n")}`
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  return hash.toString(36)
}

function lineRange(file: RelatedFile): string | null {
  if (file.startLine === null || file.endLine === null) return null
  return file.startLine === file.endLine ? `L${file.startLine}` : `L${file.startLine}–${file.endLine}`
}

export function RelatedFilesSection({ taskId, task }: {
  taskId: string
  task: { title: string; description: string | null; labels: ReadonlyArray<{ name: string }> }
}) {
  const client = useAppQueryClient()
  const revision = relatedFilesRevision(task)
  const related = useQuery({
    queryKey: ["ol", "tasks", "detail", taskId, "related-files", { revision }],
    queryFn: ({ signal }) => fetchRelatedFiles(taskId, { signal }),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (query.state.data?.status === "indexing" ? query.state.data.retryAfterMs ?? DEFAULT_RETRY_MS : false),
  }, client)
  const data = related.data
  const files = data?.status === "ready" ? data.files : []
  if (files.length === 0) return null
  const commit = data?.repository?.commit ? data.repository.commit.slice(0, 12) : null
  return (
    <section aria-labelledby={`related-files-${taskId}`} className="pt-4 border-t border-linear-border">
      <h3
        id={`related-files-${taskId}`}
        className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-linear-text-tertiary"
        title={`Files in the repository${commit ? ` at ${commit}` : ""} that share words with this task. Suggestions only; the agent gets the same list.`}
      >
        <FileCode2 className="h-3 w-3" aria-hidden="true" />
        Related files
      </h3>
      <ul className="space-y-1.5">
        {files.map((file) => {
          const range = lineRange(file)
          return (
            <li key={file.path} className="min-w-0" title={file.reasons.join(" · ")}>
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate font-mono text-[11px] text-linear-text" dir="ltr">{file.path}</span>
                {range && <span className="shrink-0 font-mono text-[10px] text-linear-text-tertiary">{range}</span>}
              </div>
              {file.matched.length > 0 && (
                <p className="truncate text-[11px] text-linear-text-tertiary">matched: {file.matched.slice(0, 5).join(", ")}</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
