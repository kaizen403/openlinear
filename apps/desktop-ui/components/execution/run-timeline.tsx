"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { defaultRangeExtractor, measureElement as measureWithObserver, useVirtualizer, type Range } from "@tanstack/react-virtual"
import { ArrowDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { focusRing } from "@/components/ui/focus-ring"
import { isEditableTarget } from "@/components/board/keyboard-guards"
import type { TimelineEntry } from "@/lib/run-model"
import { KIT_TEXT } from "./tokens"
import {
  TimelineRow,
  describeRow,
  estimateRowSize,
  isExpandable,
  isExpandedByDefault,
  type TimelineRowData,
} from "./timeline-row"

const FOLLOW_THRESHOLD_PX = 32
const ANNOUNCE_EVERY_MS = 2_000

export interface RunTimelineProps {
  entries: readonly TimelineEntry[]
  /** Oldest entries the model dropped; shown as one marker row. */
  droppedEntries?: number
  /** The run is producing events (labels the jump button "Jump to live"). */
  live?: boolean
  label?: string
  className?: string
  /** Rendered instead of the list when there are no entries. */
  empty?: ReactNode
  /** Rows to render beyond the viewport (default 8). */
  overscan?: number
}

/**
 * True when Escape should collapse a timeline row instead of closing the
 * surrounding Radix sheet. Radix listens for Escape on `document` in the
 * capture phase, so sheets must call this from `onEscapeKeyDown` and
 * `preventDefault()` when it returns true.
 */
export function timelineConsumesEscape(event: { target: EventTarget | null }): boolean {
  const target = event.target
  if (!target || typeof (target as Element).closest !== "function") return false
  const row = (target as Element).closest("[data-run-timeline] [data-expanded]")
  return row?.getAttribute("data-expanded") === "true"
}

/** Announce notable rows politely, at most once per interval (never per event). */
function useThrottledAnnouncement(latest: string | null): string {
  const [text, setText] = useState("")
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastAt = useRef(0)

  useEffect(() => {
    if (!latest) return
    pending.current = latest
    const flush = () => {
      timer.current = null
      lastAt.current = Date.now()
      setText(pending.current ?? "")
    }
    const wait = ANNOUNCE_EVERY_MS - (Date.now() - lastAt.current)
    if (wait <= 0) flush()
    else if (!timer.current) timer.current = setTimeout(flush, wait)
  }, [latest])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  return text
}

function notable(row: TimelineRowData | undefined): string | null {
  if (!row) return null
  if (row.kind === "error" || row.kind === "file" || row.kind === "attempt") return describeRow(row)
  if (row.kind === "tool" && row.status !== "running") return describeRow(row)
  return null
}

/**
 * The run timeline: a virtualized ARIA feed. Tool calls are compact rows that
 * expand on Enter (Escape collapses); j/k or the arrow keys move between rows
 * (roving focus — the focused row is always rendered even when virtualized
 * away). The view follows new rows while it's at the bottom; scrolling up
 * shows a sticky "Jump to live" button instead of fighting the reader.
 */
export function RunTimeline({ entries, droppedEntries = 0, live = false, label = "Run timeline", className, empty, overscan = 8 }: RunTimelineProps) {
  const rows = useMemo<TimelineRowData[]>(
    () => (droppedEntries > 0 ? [{ kind: "dropped", id: "dropped", count: droppedEntries, at: null, attempt: 0 }, ...entries] : [...entries]),
    [entries, droppedEntries],
  )
  const indexById = useMemo(() => {
    const map = new Map<string, number>()
    for (let index = 0; index < rows.length; index++) map.set(rows[index]!.id, index)
    return map
  }, [rows])

  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [activeId, setActiveId] = useState<string | null>(null)
  const activeIndex = activeId !== null ? indexById.get(activeId) ?? -1 : -1
  const tabStopIndex = activeIndex >= 0 ? activeIndex : rows.length - 1

  const isRowExpanded = useCallback(
    (row: TimelineRowData | undefined) => Boolean(row && isExpandable(row) && (overrides.get(row.id) ?? isExpandedByDefault(row))),
    [overrides],
  )

  // Refs so the virtualizer's callbacks always read the latest render's data.
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const expandedRef = useRef(isRowExpanded)
  expandedRef.current = isRowExpanded
  const tabStopRef = useRef(tabStopIndex)
  tabStopRef.current = tabStopIndex

  const scrollRef = useRef<HTMLDivElement>(null)
  const estimate = useCallback((index: number) => {
    const row = rowsRef.current[index]
    return estimateRowSize(row, expandedRef.current(row))
  }, [])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: estimate,
    getItemKey: (index) => rowsRef.current[index]?.id ?? index,
    overscan,
    rangeExtractor: useCallback((range: Range) => {
      const indexes = defaultRangeExtractor(range)
      const stop = tabStopRef.current
      if (stop >= 0 && stop < range.count && !indexes.includes(stop)) {
        indexes.push(stop)
        indexes.sort((a, b) => a - b)
      }
      return indexes
    }, []),
    // Hidden containers and test DOMs measure 0; keep the estimate then.
    measureElement: (element, entry, instance) => {
      const size = measureWithObserver(element, entry, instance)
      if (size > 0) return size
      return estimate(Number(element.getAttribute("data-index")))
    },
  })

  // ── Following the live edge ────────────────────────────────────────────────
  const followRef = useRef(true)
  const [following, setFollowing] = useState(true)
  const [unseen, setUnseen] = useState(0)
  const lastRowIdRef = useRef<string | null>(null)

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_THRESHOLD_PX
    if (atBottom === followRef.current) return
    followRef.current = atBottom
    setFollowing(atBottom)
    if (atBottom) setUnseen(0)
  }, [])

  useLayoutEffect(() => {
    const lastId = rows[rows.length - 1]?.id ?? null
    const previous = lastRowIdRef.current
    lastRowIdRef.current = lastId
    if (lastId === null || lastId === previous) return
    if (followRef.current) {
      virtualizer.scrollToIndex(rows.length - 1, { align: "end" })
      return
    }
    const previousIndex = previous ? indexById.get(previous) ?? -1 : -1
    setUnseen((count) => count + (previousIndex >= 0 ? rows.length - 1 - previousIndex : 1))
  }, [rows, indexById, virtualizer])

  const jumpToLatest = useCallback(() => {
    followRef.current = true
    setFollowing(true)
    setUnseen(0)
    if (rowsRef.current.length > 0) virtualizer.scrollToIndex(rowsRef.current.length - 1, { align: "end" })
  }, [virtualizer])

  // ── Keyboard: roving focus, expand, collapse ───────────────────────────────
  const pendingFocusRef = useRef<string | null>(null)
  useEffect(() => {
    const id = pendingFocusRef.current
    if (!id || id !== activeId) return
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-row-id="${id.replace(/["\\]/g, "\\$&")}"]`)
    if (element) {
      pendingFocusRef.current = null
      element.focus({ preventScroll: true })
    }
  })

  const toggle = useCallback((id: string) => {
    const row = rowsRef.current[indexById.get(id) ?? -1]
    if (!row || !isExpandable(row)) return
    const expanded = expandedRef.current(row)
    setOverrides((previous) => new Map(previous).set(id, !expanded))
  }, [indexById])

  const activate = useCallback((id: string) => setActiveId(id), [])

  const move = useCallback((index: number) => {
    const count = rowsRef.current.length
    if (count === 0) return
    const next = Math.min(count - 1, Math.max(0, index))
    const id = rowsRef.current[next]!.id
    pendingFocusRef.current = id
    setActiveId(id)
    virtualizer.scrollToIndex(next, { align: "auto" })
  }, [virtualizer])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (isEditableTarget(event.target)) return
    const current = activeIndex >= 0 ? activeIndex : tabStopIndex
    const row = rows[current]
    switch (event.key) {
      case "j":
      case "ArrowDown":
        move(current + 1)
        break
      case "k":
      case "ArrowUp":
        move(current - 1)
        break
      case "Home":
        move(0)
        break
      case "End":
        move(rows.length - 1)
        break
      case "Enter":
        if (!row || !isExpandable(row)) return
        toggle(row.id)
        break
      case "Escape":
        // Collapse the focused row; otherwise let Escape reach the sheet.
        if (!row || !isRowExpanded(row)) return
        setOverrides((previous) => new Map(previous).set(row.id, false))
        break
      default:
        return
    }
    event.preventDefault()
    event.stopPropagation()
  }, [activeIndex, tabStopIndex, rows, move, toggle, isRowExpanded])

  const latestNotable = notable(rows[rows.length - 1])
  const announcement = useThrottledAnnouncement(latestNotable)

  if (rows.length === 0) {
    return <div className={cn("min-h-0", className)}>{empty}</div>
  }

  const items = virtualizer.getVirtualItems()
  return (
    <div className={cn("relative flex min-h-0 flex-col", className)} data-run-timeline="">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-run-timeline-scroller=""
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          role="feed"
          aria-label={label}
          aria-busy={false}
          onKeyDown={onKeyDown}
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((item) => {
            const row = rows[item.index]
            if (!row) return null
            const expanded = isRowExpanded(row)
            return (
              <div
                key={item.key}
                data-index={item.index}
                data-expanded={expanded ? "true" : "false"}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <TimelineRow
                  row={row}
                  index={item.index}
                  setSize={rows.length}
                  expanded={expanded}
                  active={item.index === activeIndex}
                  tabStop={item.index === tabStopIndex}
                  onToggle={toggle}
                  onActivate={activate}
                />
              </div>
            )
          })}
        </div>
      </div>
      {!following && (
        <button
          type="button"
          onClick={jumpToLatest}
          aria-label={`${live ? "Jump to live" : "Jump to latest"}${unseen > 0 ? `, ${unseen} new` : ""}`}
          className={cn(
            "absolute bottom-2 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-linear-border-hover bg-surface-hover px-3 text-xs font-medium shadow-overlay hover:bg-surface-pressed",
            KIT_TEXT.primary.className,
            focusRing,
          )}
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          {live ? "Jump to live" : "Jump to latest"}
          {unseen > 0 && <span className={KIT_TEXT.secondary.className}>{` · ${unseen} new`}</span>}
        </button>
      )}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  )
}
