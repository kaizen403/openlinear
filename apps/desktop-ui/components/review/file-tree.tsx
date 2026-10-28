"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { ChevronDown, ChevronRight, Folder } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRingInset } from "@/components/ui/focus-ring"
import type { DiffFile } from "@/lib/api/review"
import { buildFileTree, flattenTree, type VisibleTreeItem } from "./model/tree"
import { ADDITIONS_TEXT, DELETIONS_TEXT, DRAFT_BADGE, FILE_STATUS_MARK, TEXT } from "./diff-colors"

interface FileTreeProps {
  files: readonly DiffFile[]
  /** File shown at the top of the diff (highlighted, `aria-current`). */
  currentFileIndex: number
  commentCounts: ReadonlyMap<string, number>
  onSelectFile: (fileIndex: number) => void
  className?: string
}

function fileLabel(file: DiffFile, comments: number): string {
  const status = FILE_STATUS_MARK[file.status].label.toLowerCase()
  const counts = file.status === "binary" ? "" : `, ${file.additions} added, ${file.deletions} removed`
  return `${file.path}, ${status}${counts}${comments > 0 ? `, ${comments} draft comment${comments === 1 ? "" : "s"}` : ""}`
}

/**
 * Changed files as an ARIA tree: ↑/↓ move, → expands/enters, ← collapses/goes
 * to the parent, Home/End, Enter/Space opens the file in the diff. One tab stop.
 */
export const FileTree = memo(function FileTree({ files, currentFileIndex, commentCounts, onSelectFile, className }: FileTreeProps) {
  const tree = useMemo(() => buildFileTree(files), [files])
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const items = useMemo(() => flattenTree(tree, collapsed), [tree, collapsed])
  const [focusId, setFocusId] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const currentId = files[currentFileIndex] ? `f:${files[currentFileIndex]!.path}` : null
  const focusIndex = Math.max(0, items.findIndex((item) => item.node.id === (focusId ?? currentId)))
  const tabStopId = items[focusIndex]?.node.id ?? null

  const pendingFocus = useRef(false)
  useEffect(() => {
    if (!pendingFocus.current || !tabStopId) return
    pendingFocus.current = false
    listRef.current?.querySelector<HTMLElement>(`[data-tree-id="${tabStopId.replace(/["\\]/g, "\\$&")}"]`)?.focus()
  })

  const moveTo = useCallback((item: VisibleTreeItem | undefined) => {
    if (!item) return
    pendingFocus.current = true
    setFocusId(item.node.id)
  }, [])

  const toggle = useCallback((id: string, open?: boolean) => {
    setCollapsed((previous) => {
      const next = new Set(previous)
      const isOpen = !previous.has(id)
      if ((open ?? !isOpen) === isOpen) return previous
      if (isOpen) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      const item = items[focusIndex]
      if (!item) return
      let handled = true
      switch (event.key) {
        case "ArrowDown":
          moveTo(items[focusIndex + 1])
          break
        case "ArrowUp":
          moveTo(items[focusIndex - 1])
          break
        case "Home":
          moveTo(items[0])
          break
        case "End":
          moveTo(items[items.length - 1])
          break
        case "ArrowRight":
          if (item.node.kind === "dir") {
            if (!item.expanded) toggle(item.node.id, true)
            else moveTo(items[focusIndex + 1])
          }
          break
        case "ArrowLeft":
          if (item.node.kind === "dir" && item.expanded) toggle(item.node.id, false)
          else if (item.parentId) moveTo(items.find((candidate) => candidate.node.id === item.parentId))
          break
        case "Enter":
        case " ":
          if (item.node.kind === "file") onSelectFile(item.node.fileIndex)
          else toggle(item.node.id)
          break
        default:
          handled = false
      }
      if (handled) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    [focusIndex, items, moveTo, onSelectFile, toggle],
  )

  if (files.length === 0) return null

  return (
    <ul ref={listRef} role="tree" aria-label="Changed files" onKeyDown={onKeyDown} className={cn("py-1 text-[12px]", className)}>
      {items.map((item) => {
        const { node } = item
        const tabStop = node.id === tabStopId
        const indent = { paddingLeft: `${8 + (item.depth - 1) * 12}px` }
        if (node.kind === "dir") {
          return (
            <li
              key={node.id}
              role="treeitem"
              data-tree-id={node.id}
              aria-level={item.depth}
              aria-posinset={item.posinset}
              aria-setsize={item.setsize}
              aria-expanded={item.expanded}
              aria-label={`${node.name}, folder, ${node.fileCount} file${node.fileCount === 1 ? "" : "s"}`}
              tabIndex={tabStop ? 0 : -1}
              onFocus={() => setFocusId(node.id)}
              onClick={() => toggle(node.id)}
              style={indent}
              className={cn("flex h-6 cursor-pointer items-center gap-1 pr-2 text-linear-text-secondary hover:bg-foreground/5", focusRingInset)}
            >
              {item.expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <Folder className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{node.name}</span>
            </li>
          )
        }
        const mark = FILE_STATUS_MARK[node.file.status]
        const comments = commentCounts.get(node.path) ?? 0
        const current = node.id === currentId
        return (
          <li
            key={node.id}
            role="treeitem"
            data-tree-id={node.id}
            aria-level={item.depth}
            aria-posinset={item.posinset}
            aria-setsize={item.setsize}
            aria-selected={current}
            aria-current={current ? "true" : undefined}
            aria-label={fileLabel(node.file, comments)}
            tabIndex={tabStop ? 0 : -1}
            onFocus={() => setFocusId(node.id)}
            onClick={() => onSelectFile(node.fileIndex)}
            style={indent}
            title={node.path}
            className={cn(
              "flex h-6 cursor-pointer items-center gap-1.5 pr-2 hover:bg-foreground/5",
              current ? "bg-foreground/10 text-foreground" : "text-linear-text-secondary",
              focusRingInset,
            )}
          >
            <span className={cn("w-3 shrink-0 text-center font-mono font-semibold", mark.className)} aria-hidden="true">{mark.letter}</span>
            <span className={cn("min-w-0 flex-1 truncate", node.file.status === "deleted" && "line-through decoration-destructive/60")}>{node.name}</span>
            {comments > 0 && <span className={cn("shrink-0 rounded-sm border px-1 text-[10px]", DRAFT_BADGE)} aria-hidden="true">{comments}</span>}
            {node.file.status !== "binary" ? (
              <span className="shrink-0 font-mono text-[11px]" aria-hidden="true">
                <span className={ADDITIONS_TEXT}>+{node.file.additions}</span>{" "}
                <span className={DELETIONS_TEXT}>−{node.file.deletions}</span>
              </span>
            ) : (
              <span className={cn("shrink-0 text-[11px]", TEXT.muted)} aria-hidden="true">bin</span>
            )}
          </li>
        )
      })}
    </ul>
  )
})
