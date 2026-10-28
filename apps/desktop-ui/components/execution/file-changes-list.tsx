"use client"

import { memo, useState } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import type { FileChange } from "@/lib/run-model"
import { FILE_CHANGE_MARK, KIT_TEXT, TONE_SURFACE, TONE_TEXT } from "./tokens"

const COLLAPSED_LIMIT = 8

function splitPath(path: string): { dir: string; base: string } {
  const index = path.lastIndexOf("/")
  return index === -1 ? { dir: "", base: path } : { dir: path.slice(0, index + 1), base: path.slice(index + 1) }
}

interface FileChangesListProps {
  files: readonly FileChange[]
  /** Paths beyond the model's file cap (counted, not listed). */
  overflow?: number
  className?: string
  /** Shown when nothing changed yet. */
  emptyText?: string
}

/**
 * Files the run touched, with A/M/D markers. Markers are letters plus colour
 * plus an accessible label, never colour alone. Today's sidecar only reports
 * edits ("M"); the run journal's `file.changed {kind}` adds A and D.
 */
export const FileChangesList = memo(function FileChangesList({ files, overflow = 0, className, emptyText = "No file changes reported yet." }: FileChangesListProps) {
  const [showAll, setShowAll] = useState(false)
  const total = files.length + overflow
  const visible = showAll ? files : files.slice(0, COLLAPSED_LIMIT)

  return (
    <section aria-label="Files changed" className={cn("min-w-0", className)}>
      <h3 className={cn("mb-1.5 text-[11px] font-medium uppercase tracking-wide", KIT_TEXT.secondary.className)}>
        Files changed <span className="tabular-nums">({total})</span>
      </h3>
      {total === 0 ? (
        <p className={cn("text-xs", KIT_TEXT.muted.className)}>{emptyText}</p>
      ) : (
        <>
          <ul className="space-y-0.5">
            {visible.map((file) => {
              const mark = FILE_CHANGE_MARK[file.change]
              const { dir, base } = splitPath(file.path)
              return (
                <li key={file.path} className="flex h-6 min-w-0 items-center gap-2 text-xs" title={file.path}>
                  <span
                    className={cn(
                      "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border font-mono text-[10px] font-semibold",
                      TONE_SURFACE[mark.tone],
                      TONE_TEXT[mark.tone].className,
                    )}
                    aria-hidden="true"
                  >
                    {mark.letter}
                  </span>
                  <span className="sr-only">{mark.label}:</span>
                  <span className="flex min-w-0 font-mono">
                    {dir && <span className={cn("min-w-0 truncate", KIT_TEXT.muted.className)}>{dir}</span>}
                    <span className={cn("shrink-0", KIT_TEXT.primary.className)}>{base}</span>
                  </span>
                  {file.edits > 1 && (
                    <span className={cn("ml-auto shrink-0 tabular-nums", KIT_TEXT.muted.className)}>
                      <span aria-hidden="true">×{file.edits}</span>
                      <span className="sr-only">{file.edits} edits</span>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
          {(files.length > COLLAPSED_LIMIT || overflow > 0) && (
            <div className="mt-1 flex items-center gap-2">
              {files.length > COLLAPSED_LIMIT && (
                <button
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                  aria-expanded={showAll}
                  className={cn("inline-flex items-center gap-1 rounded-sm px-1 text-xs hover:text-linear-text", KIT_TEXT.secondary.className, focusRing)}
                >
                  <ChevronDown className={cn("h-3.5 w-3.5 transition-transform motion-reduce:transition-none", showAll && "rotate-180")} aria-hidden="true" />
                  {showAll ? "Show fewer" : `Show all ${files.length}`}
                </button>
              )}
              {overflow > 0 && (
                <span className={cn("text-xs", KIT_TEXT.muted.className)}>+{overflow} more not listed</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  )
})
