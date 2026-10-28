"use client"

import { memo, type KeyboardEvent, type MouseEvent } from "react"
import {
  AlertCircle,
  Check,
  ChevronRight,
  FileMinus,
  FilePen,
  FilePlus,
  Info,
  Loader2,
  Minus,
  TerminalSquare,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRingInset } from "@/components/ui/focus-ring"
import { formatDuration, toolTitle, type TimelineEntry, type ToolEntry } from "@/lib/run-model"
import { FILE_CHANGE_MARK, KIT_TEXT, TONE_TEXT } from "./tokens"

/** A timeline row: a model entry or the "earlier entries dropped" marker. */
export type TimelineRowData = TimelineEntry | { kind: "dropped"; id: "dropped"; count: number; at: null; attempt: 0 }

export const ROW_HEIGHT = 24
const LONG_TEXT_CHARS = 480

export function isExpandable(row: TimelineRowData): boolean {
  switch (row.kind) {
    case "tool":
      return row.status !== "running" && Boolean(row.args || row.output)
    case "assistant":
      return row.text.length > LONG_TEXT_CHARS || row.text.split("\n").length > 6
    case "reasoning":
      return row.text.length > 90
    case "system":
    case "error":
      return Boolean(row.details)
    default:
      return false
  }
}

/** Errors open by default (R5 §5.12); everything else starts collapsed. */
export function isExpandedByDefault(row: TimelineRowData): boolean {
  return row.kind === "tool" && row.status === "error" && Boolean(row.output)
}

export function estimateRowSize(row: TimelineRowData | undefined, expanded: boolean): number {
  if (!row) return ROW_HEIGHT
  switch (row.kind) {
    case "assistant": {
      const lines = Math.max(1, Math.ceil(Math.min(row.text.length, expanded ? row.text.length : LONG_TEXT_CHARS) / 80))
      return 12 + lines * 20
    }
    case "attempt":
      return 32
    case "dropped":
      return 28
    default:
      return expanded ? ROW_HEIGHT + 140 : ROW_HEIGHT
  }
}

function formatClock(at: number | null): string | null {
  if (at === null) return null
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
}

function ToolStatusIcon({ tool }: { tool: ToolEntry }) {
  switch (tool.status) {
    case "running":
      return <Loader2 className={cn("h-3.5 w-3.5 motion-safe:animate-spin", TONE_TEXT.info.className)} aria-hidden="true" />
    case "completed":
      return <Check className={cn("h-3.5 w-3.5", TONE_TEXT.success.className)} aria-hidden="true" />
    case "error":
      return <X className={cn("h-3.5 w-3.5", TONE_TEXT.danger.className)} aria-hidden="true" />
    default:
      return <Minus className={cn("h-3.5 w-3.5", KIT_TEXT.muted.className)} aria-hidden="true" />
  }
}

const TOOL_STATUS_TEXT: Readonly<Record<ToolEntry["status"], string>> = {
  running: "running",
  completed: "completed",
  error: "failed",
  unfinished: "no result reported",
}

/** Plain-language row summary, used for the accessible name. */
export function describeRow(row: TimelineRowData): string {
  switch (row.kind) {
    case "tool": {
      const duration = formatDuration(row.durationMs)
      return `${row.isCommand ? "Command" : toolTitle(row.name)}${row.summary ? ` ${row.summary}` : ""}, ${TOOL_STATUS_TEXT[row.status]}${duration ? `, ${duration}` : ""}`
    }
    case "assistant":
      return `Agent: ${row.text.slice(0, 140)}`
    case "reasoning":
      return `Reasoning: ${row.text.slice(0, 140)}`
    case "file":
      return `${FILE_CHANGE_MARK[row.change].label} file ${row.path}`
    case "system":
      return row.text
    case "error":
      return `Error: ${row.text}`
    case "attempt":
      return row.text
    case "dropped":
      return `${row.count} earlier entries are not shown`
  }
}

interface TimelineRowProps {
  row: TimelineRowData
  index: number
  setSize: number
  expanded: boolean
  active: boolean
  tabStop: boolean
  onToggle: (id: string) => void
  onActivate: (id: string) => void
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      className={cn("h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none", KIT_TEXT.muted.className, expanded && "rotate-90")}
      aria-hidden="true"
    />
  )
}

function Pre({ label, text, tone }: { label: string; text: string; tone?: "danger" }) {
  return (
    <div className="min-w-0">
      <p className={cn("mb-1 text-[11px] font-medium uppercase tracking-wide", KIT_TEXT.muted.className)}>{label}</p>
      <pre
        className={cn(
          "max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-sm border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-xs leading-5",
          tone === "danger" ? TONE_TEXT.danger.className : KIT_TEXT.secondary.className,
        )}
      >
        {text}
      </pre>
    </div>
  )
}

function RowBody({ row }: { row: TimelineRowData }) {
  switch (row.kind) {
    case "tool":
      return (
        <div className="cursor-auto space-y-2 pb-2 pl-6 pr-2" data-row-body="">
          {row.args && <Pre label="Arguments" text={row.args} />}
          {row.output && <Pre label={row.status === "error" ? "Error" : "Output"} text={row.output} tone={row.status === "error" ? "danger" : undefined} />}
          {row.outputTruncated && <p className={cn("text-[11px]", KIT_TEXT.muted.className)}>Output shortened to keep long runs fast.</p>}
        </div>
      )
    case "system":
    case "error":
      return row.details ? (
        <div className="cursor-auto pb-2 pl-6 pr-2" data-row-body="">
          <Pre label="Details" text={row.details} tone={row.kind === "error" ? "danger" : undefined} />
        </div>
      ) : null
    default:
      return null
  }
}

function RowHeader({ row, expanded, expandable }: { row: TimelineRowData; expanded: boolean; expandable: boolean }) {
  const time = formatClock(row.at)
  const timeNode = time ? (
    <span className={cn("ml-auto shrink-0 pl-2 text-[11px] tabular-nums", KIT_TEXT.muted.className)}>{time}</span>
  ) : null

  switch (row.kind) {
    case "tool": {
      const duration = formatDuration(row.durationMs)
      const pending = row.status === "running"
      return (
        <div className="flex h-6 min-w-0 items-center gap-2">
          <span className="flex w-4 shrink-0 justify-center"><ToolStatusIcon tool={row} /></span>
          {row.isCommand ? (
            <TerminalSquare className={cn("h-3.5 w-3.5 shrink-0", KIT_TEXT.muted.className)} aria-hidden="true" />
          ) : (
            <Wrench className={cn("h-3.5 w-3.5 shrink-0", KIT_TEXT.muted.className)} aria-hidden="true" />
          )}
          <span className={cn("shrink-0 text-xs font-medium", row.status === "error" ? TONE_TEXT.danger.className : KIT_TEXT.primary.className)}>
            {row.isCommand ? "Shell" : toolTitle(row.name)}
          </span>
          {row.summary && (
            <>
              <span className={cn("shrink-0 text-xs", KIT_TEXT.muted.className)} aria-hidden="true">·</span>
              <span
                className={cn("min-w-0 truncate text-xs", row.isCommand && "font-mono", KIT_TEXT.secondary.className, row.status === "unfinished" && "line-through decoration-white/30")}
                title={row.summary}
              >
                {row.isCommand ? `$ ${row.summary}` : row.summary}
              </span>
            </>
          )}
          <span className={cn("ml-auto shrink-0 pl-2 text-[11px] tabular-nums", KIT_TEXT.muted.className)}>
            {pending ? "running" : row.status === "unfinished" ? "no result" : duration}
          </span>
          {expandable ? <Chevron expanded={expanded} /> : <span className="w-3.5 shrink-0" aria-hidden="true" />}
        </div>
      )
    }
    case "file": {
      const mark = FILE_CHANGE_MARK[row.change]
      const Icon = row.change === "added" ? FilePlus : row.change === "deleted" ? FileMinus : FilePen
      return (
        <div className="flex h-6 min-w-0 items-center gap-2">
          <span className="flex w-4 shrink-0 justify-center">
            <Icon className={cn("h-3.5 w-3.5", TONE_TEXT[mark.tone].className)} aria-hidden="true" />
          </span>
          <span className={cn("shrink-0 text-xs", KIT_TEXT.secondary.className)}>{mark.label}</span>
          <span className={cn("min-w-0 truncate font-mono text-xs", KIT_TEXT.primary.className)} title={row.path}>{row.path}</span>
          {timeNode}
          <span className="w-3.5 shrink-0" aria-hidden="true" />
        </div>
      )
    }
    case "system":
    case "error": {
      const isError = row.kind === "error"
      const warning = row.kind === "system" && row.tone === "warning"
      const success = row.kind === "system" && row.tone === "success"
      const Icon = isError ? AlertCircle : warning ? TriangleAlert : success ? Check : Info
      return (
        <div className="flex h-6 min-w-0 items-center gap-2">
          <span className="flex w-4 shrink-0 justify-center">
            <Icon
              className={cn(
                "h-3.5 w-3.5",
                isError ? TONE_TEXT.danger.className : warning ? TONE_TEXT.warning.className : success ? TONE_TEXT.success.className : KIT_TEXT.muted.className,
              )}
              aria-hidden="true"
            />
          </span>
          <span className={cn("min-w-0 truncate text-xs", isError ? TONE_TEXT.danger.className : KIT_TEXT.secondary.className)} title={row.text}>
            {row.text}
          </span>
          {timeNode}
          {expandable ? <Chevron expanded={expanded} /> : <span className="w-3.5 shrink-0" aria-hidden="true" />}
        </div>
      )
    }
    default:
      return null
  }
}

/**
 * One timeline row (an ARIA feed article). Tool calls are compact 24px rows
 * that expand to show arguments and output; agent text renders without a
 * bubble; reasoning sits at a lower weight behind a rail.
 */
export const TimelineRow = memo(function TimelineRow({ row, index, setSize, expanded, active, tabStop, onToggle, onActivate }: TimelineRowProps) {
  const expandable = isExpandable(row)
  // Mouse: a click anywhere on the row toggles it, except inside the expanded
  // body (so output can be selected). Keyboard: Enter/Escape are handled by
  // the timeline (feed) for the focused row; Space toggles here.
  const onClick = (event: MouseEvent<HTMLElement>) => {
    onActivate(row.id)
    if (!expandable) return
    if ((event.target as Element).closest?.("[data-row-body]")) return
    if (typeof window !== "undefined" && window.getSelection()?.toString()) return
    event.preventDefault()
    onToggle(row.id)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === " " && expandable && event.target === event.currentTarget) {
      event.preventDefault()
      onToggle(row.id)
    }
  }

  const common = {
    "data-row-id": row.id,
    "data-kind": row.kind,
    "aria-posinset": index + 1,
    "aria-setsize": setSize,
    "aria-label": `${describeRow(row)}${expandable ? (expanded ? ", expanded" : ", collapsed") : ""}`,
    tabIndex: tabStop ? 0 : -1,
    onFocus: () => onActivate(row.id),
    className: cn(
      "group/row relative rounded-sm px-1",
      focusRingInset,
      expandable && "cursor-pointer",
      active && "bg-white/[0.04]",
    ),
  } as const

  if (row.kind === "dropped") {
    return (
      <article {...common} onClick={onClick} onKeyDown={onKeyDown}>
        <p className={cn("flex h-7 items-center gap-2 text-xs", KIT_TEXT.muted.className)}>
          <Minus className="h-3.5 w-3.5" aria-hidden="true" />
          {row.count.toLocaleString()} earlier {row.count === 1 ? "entry is" : "entries are"} not shown — totals still include them.
        </p>
      </article>
    )
  }

  if (row.kind === "attempt") {
    return (
      <article {...common} onClick={onClick} onKeyDown={onKeyDown}>
        <div className="flex h-8 items-center gap-2" aria-hidden="true">
          <span className="h-px flex-1 bg-white/10" />
          <span className={cn("text-[11px] font-medium uppercase tracking-wide", KIT_TEXT.secondary.className)}>{row.text}</span>
          <span className="h-px flex-1 bg-white/10" />
        </div>
      </article>
    )
  }

  if (row.kind === "assistant") {
    return (
      <article {...common} onClick={onClick} onKeyDown={onKeyDown}>
        <div className="flex gap-2 py-1">
          <span className="mt-2 flex w-4 shrink-0 justify-center" aria-hidden="true">
            <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
          </span>
          <p className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-5", KIT_TEXT.primary.className, !expanded && expandable && "line-clamp-6")}>
            {row.text}
          </p>
          {expandable ? <span className="mt-1"><Chevron expanded={expanded} /></span> : <span className="w-3.5 shrink-0" aria-hidden="true" />}
        </div>
      </article>
    )
  }

  if (row.kind === "reasoning") {
    return (
      <article {...common} onClick={onClick} onKeyDown={onKeyDown}>
        <div className="flex gap-2 py-1">
          <span className="flex w-4 shrink-0 justify-center" aria-hidden="true">
            <span className="h-full w-px bg-white/15" />
          </span>
          <p
            className={cn(
              "min-w-0 flex-1 text-xs italic leading-5",
              KIT_TEXT.muted.className,
              expanded ? "whitespace-pre-wrap break-words" : "truncate",
            )}
          >
            <span className="not-italic font-medium">Thinking</span> {row.text}
          </p>
          {expandable ? <span className="mt-0.5"><Chevron expanded={expanded} /></span> : <span className="w-3.5 shrink-0" aria-hidden="true" />}
        </div>
      </article>
    )
  }

  const errorRail = row.kind === "tool" && row.status === "error"
  return (
    <article {...common} onClick={onClick} onKeyDown={onKeyDown}>
      {errorRail && <span className="absolute inset-y-0 left-0 w-0.5 rounded-full bg-run-danger/70" aria-hidden="true" />}
      <RowHeader row={row} expanded={expanded} expandable={expandable} />
      {expandable && expanded && <RowBody row={row} />}
    </article>
  )
})
