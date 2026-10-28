"use client"

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { defaultRangeExtractor, measureElement as measureWithObserver, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { ChevronDown, ChevronRight, MessageSquarePlus } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRingInset } from "@/components/ui/focus-ring"
import { isEditableTarget } from "@/components/board/keyboard-guards"
import type { DiffFile, DiffLine } from "@/lib/api/review"
import {
  adjacentFileStart,
  adjacentHunkStart,
  commentTargetOfRow,
  lineTextAt,
  type CommentTarget,
  type DiffRow,
  type DiffRowModel,
  type LineAnchor,
  type ViewMode,
} from "./model/rows"
import { languageForPath, tokenizeLine } from "./model/syntax"
import { CommentThread, type CommentActions } from "./comment-thread"
import { ADDITIONS_TEXT, DELETIONS_TEXT, DIFF_GUTTER_BG, DIFF_LINE_BG, FILE_STATUS_MARK, GUTTER_TEXT, HUNK_HEADER, SYNTAX_TEXT, TEXT, TONE } from "./diff-colors"

const LINE_HEIGHT = 20

export function estimateDiffRowSize(row: DiffRow | undefined): number {
  if (!row) return LINE_HEIGHT
  switch (row.kind) {
    case "file":
      return 40
    case "hunk":
      return 28
    case "notice":
      return 36
    case "thread":
      return 24 + row.comments.length * 64 + (row.editing ? 128 : row.comments.length > 0 ? 28 : 0)
    default:
      return LINE_HEIGHT
  }
}

const KIND_WORD: Readonly<Record<DiffLine["kind"], string>> = { add: "added", del: "removed", context: "unchanged" }

/** Accessible name of a line row. Text is passed through as text, never markup. */
export function describeLine(path: string, line: DiffLine, side?: "old" | "new"): string {
  const number = line.kind === "del" ? line.oldNo : line.newNo ?? line.oldNo
  const where = side === "old" ? "left" : side === "new" ? "right" : null
  return `${KIND_WORD[line.kind]} line ${number ?? "?"}${where ? ` (${where})` : ""} of ${path}: ${line.text || "(blank)"}`
}

export function describeFileRow(file: DiffFile, collapsed: boolean, comments: number): string {
  const status = FILE_STATUS_MARK[file.status].label.toLowerCase()
  const renamed = file.oldPath ? `, from ${file.oldPath}` : ""
  const counts = file.status === "binary" ? "" : `, ${file.additions} added, ${file.deletions} removed`
  const drafts = comments > 0 ? `, ${comments} draft comment${comments === 1 ? "" : "s"}` : ""
  return `File ${file.path}, ${status}${renamed}${counts}${drafts}, ${collapsed ? "collapsed" : "expanded"}`
}

// ─── Leaf rendering ───────────────────────────────────────────────────────────

const CodeText = memo(function CodeText({ text, language }: { text: string; language: string | null }) {
  const tokens = useMemo(() => tokenizeLine(text, language), [text, language])
  if (tokens.length === 0) return <span>{" "}</span>
  return (
    <>
      {tokens.map((token, index) =>
        token.kind === "plain" ? (
          <span key={index}>{token.text}</span>
        ) : (
          <span key={index} className={SYNTAX_TEXT[token.kind]}>
            {token.text}
          </span>
        ),
      )}
    </>
  )
})

function Marker({ kind }: { kind: DiffLine["kind"] }) {
  return (
    <span aria-hidden="true" className={cn("w-4 shrink-0 select-none text-center", kind === "context" ? "text-transparent" : GUTTER_TEXT)}>
      {kind === "add" ? "+" : kind === "del" ? "−" : " "}
    </span>
  )
}

function LineNumber({ value }: { value: number | undefined }) {
  return (
    <span aria-hidden="true" className={cn("w-11 shrink-0 select-none pr-2 text-right tabular-nums", GUTTER_TEXT)}>
      {value ?? ""}
    </span>
  )
}

function CommentButton({ anchor, label, onStart }: { anchor: LineAnchor | null; label: string; onStart: (target: CommentTarget) => void }) {
  if (!anchor) return null
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={label}
      title="Comment (c)"
      onClick={(event) => {
        event.stopPropagation()
        onStart(anchor)
      }}
      className="absolute left-0.5 top-0.5 z-[1] hidden h-4 w-4 items-center justify-center rounded-sm bg-primary text-primary-foreground group-hover:flex group-focus-within:flex"
    >
      <MessageSquarePlus className="h-3 w-3" aria-hidden="true" />
    </button>
  )
}

function LineCode({ line, language }: { line: DiffLine; language: string | null }) {
  return (
    <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-3 [tab-size:4]">
      <CodeText text={line.text} language={language} />
      {line.truncated && <span className={cn("ml-1 font-sans text-[11px]", TEXT.muted)}>… (line shortened)</span>}
      {line.noEol && <span className={cn("ml-1 font-sans text-[11px]", TEXT.muted)}>⏎ no newline at end of file</span>}
    </span>
  )
}

function HalfLine({ line, anchor, language, path, side, onStart }: {
  line: DiffLine | null
  anchor: LineAnchor | null
  language: string | null
  path: string
  side: "old" | "new"
  onStart: (target: CommentTarget) => void
}) {
  if (!line) return <div className="flex min-w-0 flex-1 bg-foreground/[0.02]" aria-hidden="true" />
  const kind = line.kind
  return (
    <div className={cn("group relative flex min-w-0 flex-1", DIFF_LINE_BG[kind])}>
      <CommentButton anchor={anchor} label={`Comment on ${describeLine(path, line, side)}`} onStart={onStart} />
      <span className={cn("flex shrink-0", DIFF_GUTTER_BG[kind])}>
        <LineNumber value={side === "old" ? line.oldNo : line.newNo} />
      </span>
      <Marker kind={kind} />
      <LineCode line={line} language={language} />
    </div>
  )
}

// ─── Viewer ──────────────────────────────────────────────────────────────────

export interface DiffViewerHandle {
  /** Scrolls to and focuses a row by index. */
  focusRow: (index: number) => void
  focusFile: (fileIndex: number) => void
  /** j/k/n/p from elsewhere in the panel. */
  navigate: (key: "j" | "k" | "n" | "p") => boolean
}

export interface DiffViewerProps {
  model: DiffRowModel
  files: readonly DiffFile[]
  mode: ViewMode
  revision: string | null
  actions: CommentActions
  onToggleFile: (path: string) => void
  /** The file at the top of the viewport (for the file tree highlight). */
  onCurrentFileChange?: (fileIndex: number) => void
  className?: string
  overscan?: number
  label?: string
}

/**
 * Virtualized unified/split diff. One tab stop (roving focus over rows; the
 * focused row is always rendered even when virtualized away):
 * ↑/↓ rows · j/k files · n/p hunks · Home/End · Enter on a file header
 * collapses it, on a line opens a comment · c comments on the focused line.
 * Line text is untrusted and rendered only as React text nodes.
 */
export const DiffViewer = forwardRef<DiffViewerHandle, DiffViewerProps>(function DiffViewer(
  { model, files, mode, revision, actions, onToggleFile, onCurrentFileChange, className, overscan = 12, label = "Diff" },
  ref,
) {
  const { rows } = model
  const indexByKey = useMemo(() => {
    const map = new Map<string, number>()
    for (let index = 0; index < rows.length; index++) map.set(rows[index]!.key, index)
    return map
  }, [rows])

  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeIndex = activeKey !== null ? indexByKey.get(activeKey) ?? -1 : -1
  const tabStopIndex = activeIndex >= 0 ? activeIndex : rows.length > 0 ? 0 : -1

  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const indexByKeyRef = useRef(indexByKey)
  indexByKeyRef.current = indexByKey
  const tabStopRef = useRef(tabStopIndex)
  tabStopRef.current = tabStopIndex

  const scrollRef = useRef<HTMLDivElement>(null)
  const estimate = useCallback((index: number) => estimateDiffRowSize(rowsRef.current[index]), [])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    getItemKey: (index) => rowsRef.current[index]?.key ?? index,
    overscan,
    // Leave room for the sticky file label when a header scrolls to the top.
    scrollPaddingStart: 24,
    // A new identity per tab stop: the virtualizer memoizes its indexes on the
    // extractor, and a focus move must render its row even before (or
    // without) a scroll changing the range.
    rangeExtractor: useCallback((range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (tabStopIndex >= 0 && tabStopIndex < range.count && !indexes.includes(tabStopIndex)) {
        indexes.push(tabStopIndex)
        indexes.sort((a, b) => a - b)
      }
      return indexes
    }, [tabStopIndex]),
    // Hidden containers and test DOMs measure 0; keep the estimate then.
    measureElement: (element, entry, instance) => {
      const size = measureWithObserver(element, entry, instance)
      if (size > 0) return size
      return estimate(Number(element.getAttribute("data-index")))
    },
  })

  // Focus a row once it's rendered (after a scroll into a virtualized range).
  const pendingFocusRef = useRef<string | null>(null)
  useEffect(() => {
    const key = pendingFocusRef.current
    if (!key || key !== activeKey) return
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-row-key="${key.replace(/["\\]/g, "\\$&")}"]`)
    if (element) {
      pendingFocusRef.current = null
      element.focus({ preventScroll: true })
    }
  })

  const focusRow = useCallback(
    (index: number) => {
      const row = rowsRef.current[index]
      if (!row) return
      pendingFocusRef.current = row.key
      setActiveKey(row.key)
      virtualizer.scrollToIndex(index, { align: row.kind === "file" || row.kind === "hunk" ? "start" : "auto" })
    },
    [virtualizer],
  )

  const navigate = useCallback(
    (key: "j" | "k" | "n" | "p", fromIndex?: number): boolean => {
      const from = fromIndex ?? tabStopRef.current
      const target =
        key === "j" ? adjacentFileStart(model, from, 1)
          : key === "k" ? adjacentFileStart(model, from, -1)
            : key === "n" ? adjacentHunkStart(model, from, 1)
              : adjacentHunkStart(model, from, -1)
      if (target === null) return false
      focusRow(target)
      return true
    },
    [model, focusRow],
  )

  useImperativeHandle(
    ref,
    () => ({
      focusRow,
      focusFile: (fileIndex: number) => {
        const start = model.fileStarts[fileIndex]
        if (start !== undefined) focusRow(start)
      },
      navigate,
    }),
    [focusRow, model, navigate],
  )

  // The file at the top of the viewport.
  const virtualItems = virtualizer.getVirtualItems()
  const scrollOffset = virtualizer.scrollOffset ?? 0
  const topItem = virtualItems.find((item) => item.end > scrollOffset) ?? virtualItems[0]
  const currentFileIndex = topItem ? rows[topItem.index]?.fileIndex ?? -1 : -1
  const reportedRef = useRef(-2)
  useEffect(() => {
    if (currentFileIndex === reportedRef.current) return
    reportedRef.current = currentFileIndex
    if (currentFileIndex >= 0) onCurrentFileChange?.(currentFileIndex)
  }, [currentFileIndex, onCurrentFileChange])

  const languages = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const file of files) map.set(file.path, languageForPath(file.path))
    return map
  }, [files])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) return
      // The row the event came from (focus may have moved before React re-rendered).
      const rowKey = event.target instanceof Element ? event.target.closest("[data-row-key]")?.getAttribute("data-row-key") : null
      const current = (rowKey ? indexByKeyRef.current.get(rowKey) : undefined) ?? tabStopRef.current
      const row = rowsRef.current[current]
      let handled = true
      switch (event.key) {
        case "ArrowDown":
          if (current < rowsRef.current.length - 1) focusRow(current + 1)
          break
        case "ArrowUp":
          if (current > 0) focusRow(current - 1)
          break
        case "Home":
          focusRow(0)
          break
        case "End":
          focusRow(rowsRef.current.length - 1)
          break
        case "j":
        case "k":
        case "n":
        case "p":
          navigate(event.key, current)
          break
        case "c": {
          const target = commentTargetOfRow(row)
          if (target) actions.start(target)
          else handled = false
          break
        }
        case "Enter":
        case " ": {
          if (row?.kind === "file") onToggleFile(row.file.path)
          else if (row?.kind === "line" || row?.kind === "pair") {
            const target = commentTargetOfRow(row)
            if (target) actions.start(target)
          } else handled = false
          break
        }
        default:
          handled = false
      }
      if (handled) {
        event.preventDefault()
        event.stopPropagation()
      }
    },
    [actions, focusRow, navigate, onToggleFile],
  )

  const topRow = topItem ? rows[topItem.index] : undefined
  const stickyFile = topRow && topRow.kind !== "file" ? files[topRow.fileIndex] : undefined

  return (
    <div className={cn("relative min-h-0", className)}>
      {stickyFile && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-10 truncate border-b border-border bg-background/95 px-3 py-1 font-mono text-[12px] text-linear-text-secondary">
          {stickyFile.path}
        </div>
      )}
      <div
        ref={scrollRef}
        data-review-diff-scroller=""
        data-view-mode={mode}
        role="region"
        aria-label={label}
        aria-keyshortcuts="ArrowUp ArrowDown J K N P C Enter Home End"
        onKeyDown={onKeyDown}
        className="h-full overflow-y-auto overflow-x-hidden font-mono text-[12px] leading-5 [overflow-anchor:none]"
      >
        <div role="list" aria-label={`${label} rows`} style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualItems.map((item) => {
            const row = rows[item.index]
            if (!row) return null
            const isTabStop = item.index === tabStopIndex
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                role="listitem"
                style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
              >
                <DiffRowView
                  row={row}
                  file={files[row.fileIndex]}
                  language={languages.get(row.kind === "file" ? row.file.path : files[row.fileIndex]?.path ?? "") ?? null}
                  isTabStop={isTabStop}
                  revision={revision}
                  actions={actions}
                  onToggleFile={onToggleFile}
                  onFocusRow={setActiveKey}
                />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})

interface DiffRowViewProps {
  row: DiffRow
  file: DiffFile | undefined
  language: string | null
  isTabStop: boolean
  revision: string | null
  actions: CommentActions
  onToggleFile: (path: string) => void
  onFocusRow: (key: string) => void
}

const DiffRowView = memo(function DiffRowView({ row, file, language, isTabStop, revision, actions, onToggleFile, onFocusRow }: DiffRowViewProps) {
  const common = {
    "data-row-key": row.key,
    tabIndex: isTabStop ? 0 : -1,
    onFocus: () => onFocusRow(row.key),
  }

  switch (row.kind) {
    case "file": {
      const mark = FILE_STATUS_MARK[row.file.status]
      return (
        <div
          {...common}
          role="heading"
          aria-level={3}
          aria-label={describeFileRow(row.file, row.collapsed, row.comments)}
          data-file-header=""
          className={cn(
            "group flex h-10 items-center gap-2 border-y border-border bg-card px-2 font-sans text-[13px]",
            row.fileIndex === 0 && "border-t-0",
            focusRingInset,
          )}
        >
          {/* Mouse affordance; keyboard users press Enter on the header. */}
          <span aria-hidden="true" onClick={() => onToggleFile(row.file.path)} className="cursor-pointer rounded-sm p-0.5 text-linear-text-secondary hover:text-foreground">
            {row.collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
          <span className={cn("w-4 shrink-0 text-center font-mono text-[12px] font-semibold", mark.className)} aria-hidden="true">{mark.letter}</span>
          <span className="min-w-0 truncate font-mono text-[12px] text-foreground" title={row.file.path}>
            {row.file.oldPath && <span className="text-linear-text-secondary">{row.file.oldPath} → </span>}
            {row.file.path}
          </span>
          {row.file.untracked && <span className={cn("shrink-0 text-[11px]", TEXT.muted)}>untracked</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[12px]" aria-hidden="true">
            {row.comments > 0 && <span className={TONE.warning.text}>{row.comments} draft{row.comments === 1 ? "" : "s"}</span>}
            {row.file.status !== "binary" && (
              <>
                <span className={ADDITIONS_TEXT}>+{row.file.additions}</span>
                <span className={DELETIONS_TEXT}>−{row.file.deletions}</span>
              </>
            )}
          </span>
          <button
            type="button"
            tabIndex={-1}
            aria-label={`Comment on file ${row.file.path}`}
            title="Comment on file"
            onClick={() => actions.start({ path: row.file.path })}
            className="hidden rounded-sm p-0.5 text-linear-text-secondary hover:text-foreground group-hover:block group-focus-within:block"
          >
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )
    }
    case "hunk":
      return (
        <div
          {...common}
          aria-label={`Change ${row.ordinal} of ${row.hunkCount} in ${row.path}, old lines ${row.hunk.oldStart}–${row.hunk.oldStart + Math.max(row.hunk.oldLines - 1, 0)}, new lines ${row.hunk.newStart}–${row.hunk.newStart + Math.max(row.hunk.newLines - 1, 0)}`}
          data-hunk-header=""
          className={cn("flex h-7 items-center px-3 text-[12px]", HUNK_HEADER, focusRingInset)}
        >
          <span className="truncate">{row.hunk.header || `@@ -${row.hunk.oldStart},${row.hunk.oldLines} +${row.hunk.newStart},${row.hunk.newLines} @@`}</span>
        </div>
      )
    case "line": {
      const { line } = row
      return (
        <div
          {...common}
          aria-label={describeLine(row.path, line)}
          className={cn("group relative flex min-h-5", DIFF_LINE_BG[line.kind], focusRingInset)}
        >
          <CommentButton anchor={row.anchor} label={`Comment on ${describeLine(row.path, line)}`} onStart={actions.start} />
          <span className={cn("flex shrink-0", DIFF_GUTTER_BG[line.kind])}>
            <LineNumber value={line.oldNo} />
            <LineNumber value={line.newNo} />
          </span>
          <Marker kind={line.kind} />
          <LineCode line={line} language={language} />
        </div>
      )
    }
    case "pair": {
      const leftLabel = row.left ? describeLine(row.path, row.left, "old") : "nothing on the left"
      const rightLabel = row.right ? (row.right === row.left ? "same on the right" : describeLine(row.path, row.right, "new")) : "nothing on the right"
      return (
        <div {...common} aria-label={`${leftLabel}; ${rightLabel}`} className={cn("flex min-h-5", focusRingInset)}>
          <HalfLine line={row.left} anchor={row.leftAnchor} language={language} path={row.path} side="old" onStart={actions.start} />
          <span className="w-px shrink-0 bg-border" aria-hidden="true" />
          <HalfLine line={row.right} anchor={row.rightAnchor} language={language} path={row.path} side="new" onStart={actions.start} />
        </div>
      )
    }
    case "notice":
      return (
        <div {...common} className={cn("flex min-h-9 items-center px-4 font-sans text-[12px]", row.tone === "warning" ? TONE.warning.text : TEXT.secondary, focusRingInset)}>
          {row.text}
        </div>
      )
    case "thread":
      return (
        <div {...common} aria-label={row.orphaned ? `Comments on lines no longer in ${row.path}` : undefined} className={cn("py-0.5", focusRingInset)}>
          <CommentThread
            path={row.path}
            target={row.target}
            comments={row.comments}
            editing={row.editing}
            orphaned={row.orphaned}
            revision={revision}
            currentText={row.target.line !== undefined ? lineTextAt(file, row.target) : undefined}
            actions={actions}
          />
        </div>
      )
  }
})
