"use client"

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { formatDay } from "@/lib/api/insights"

/**
 * W15b insights charts, drawn with plain CSS (no chart dependency). Every
 * chart has a text equivalent: an `aria-label` summary, a legend with labels
 * and totals for two or more series (identity never rests on colour alone),
 * a per-column tooltip (`title`) and a "Show as table" view with every value.
 * Marks follow the dataviz specs: columns at most 24px wide, 4px rounded tops,
 * a 2px gap between stacked segments and between grouped bars.
 */

export interface ChartSeries {
  key: string
  label: string
  /** Tailwind background class of the mark (never used for text). */
  swatch: string
  values: number[]
  /** Per-day text shown instead of `format(value)` in tooltips and the table (e.g. "unknown" for a day whose runs recorded no price). */
  text?: string[]
}

function Swatch({ className }: { className: string }) {
  return <span aria-hidden="true" className={cn("inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]", className)} />
}

export function ChartLegend({ items }: { items: Array<{ key: string; label: string; swatch: string; value: ReactNode }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-linear-text-secondary">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-1.5">
          <Swatch className={item.swatch} />
          <span>{item.label}</span>
          <span className="font-mono text-linear-text">{item.value}</span>
        </li>
      ))}
    </ul>
  )
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

/** One horizontal 100% bar of parts (e.g. run outcomes), with a labelled legend. */
export function ProportionBar({ label, parts }: { label: string; parts: Array<{ key: string; label: string; swatch: string; value: number }> }) {
  const total = sum(parts.map((part) => part.value))
  const shown = parts.filter((part) => part.value > 0)
  const share = (value: number) => (total > 0 ? Math.round((value / total) * 100) : 0)
  const summary = `${label}: ${shown.map((part) => `${part.value} ${part.label.toLowerCase()} (${share(part.value)}%)`).join(", ") || "none"}`
  return (
    <div className="space-y-2">
      <div role="img" aria-label={summary} className="flex h-3 w-full gap-[2px]">
        {total === 0 ? (
          <div className="h-full w-full rounded-[4px] bg-linear-bg-tertiary" />
        ) : (
          shown.map((part, index) => (
            <div
              key={part.key}
              title={`${part.label}: ${part.value} (${share(part.value)}%)`}
              className={cn("h-full min-w-[3px]", part.swatch, index === 0 && "rounded-l-[4px]", index === shown.length - 1 && "rounded-r-[4px]")}
              style={{ flexGrow: part.value, flexBasis: 0 }}
            />
          ))
        )}
      </div>
      <ChartLegend items={parts.map((part) => ({ key: part.key, label: part.label, swatch: part.swatch, value: `${part.value} · ${share(part.value)}%` }))} />
    </div>
  )
}

interface DailyColumnsProps {
  title: string
  description?: string
  dates: string[]
  series: ChartSeries[]
  /** `stacked`: one column per day, segments bottom-up in series order. `grouped`: one bar per series. */
  mode: "stacked" | "grouped"
  format?: (value: number) => string
  /** Extra text for a day's tooltip and table row (e.g. unknown-cost runs). */
  extra?: { label: string; values: number[] }
}

/** Daily columns over a UTC date range (at most 90 points), today last. */
export function DailyColumns({ title, description, dates, series, mode, format = (value) => value.toLocaleString("en-US"), extra }: DailyColumnsProps) {
  const totals = dates.map((_, day) => sum(series.map((item) => item.values[day] ?? 0)))
  const peaks = dates.map((_, day) => (mode === "stacked" ? totals[day] : Math.max(0, ...series.map((item) => item.values[day] ?? 0))))
  const max = Math.max(0, ...peaks)
  const peakDay = peaks.indexOf(max)
  const grandTotal = sum(totals)
  const extraTotal = extra ? sum(extra.values) : 0
  const height = (value: number) => (max > 0 ? `${(value / max) * 100}%` : "0%")
  const valueText = (item: ChartSeries, day: number) => item.text?.[day] ?? format(item.values[day] ?? 0)
  const describeDay = (day: number) => {
    const parts = series.map((item) => `${valueText(item, day)} ${item.label.toLowerCase()}`)
    if (extra && (extra.values[day] ?? 0) > 0) parts.push(`${extra.values[day]} ${extra.label.toLowerCase()}`)
    return `${formatDay(dates[day])}: ${parts.join(", ")}`
  }
  const summary = max === 0
    ? extra && extraTotal > 0
      ? `${title}: nothing recorded in the last ${dates.length} days; ${extraTotal} ${extra.label.toLowerCase()}.`
      : `${title}: nothing in the last ${dates.length} days.`
    : `${title}: ${series.map((item) => `${format(sum(item.values))} ${item.label.toLowerCase()}`).join(", ")} over ${dates.length} days; busiest ${formatDay(dates[peakDay])} (${format(max)}).`
  const middle = Math.floor((dates.length - 1) / 2)

  return (
    <figure className="space-y-3">
      <figcaption>
        <h3 className="text-sm font-semibold text-linear-text">{title}</h3>
        {description && <p className="mt-0.5 text-[11px] text-linear-text-tertiary">{description}</p>}
      </figcaption>
      {series.length >= 2 && (
        <ChartLegend items={series.map((item) => ({ key: item.key, label: item.label, swatch: item.swatch, value: format(sum(item.values)) }))} />
      )}
      <div className="flex gap-2">
        <div aria-hidden="true" className="flex h-32 w-10 shrink-0 flex-col justify-between text-right font-mono text-[10px] tabular-nums text-linear-text-tertiary">
          <span>{format(max)}</span>
          <span>{format(0)}</span>
        </div>
        <div className="min-w-0 flex-1">
          <div role="img" aria-label={summary} className="flex h-32 items-end gap-px border-b border-linear-border">
            {dates.map((date, day) => (
              <div key={date} title={describeDay(day)} data-day={date} className="flex h-full min-w-0 flex-1 items-end justify-center hover:bg-layer-hover">
                {mode === "stacked" ? (
                  totals[day] > 0 && (
                    <div className="flex w-full max-w-6 flex-col-reverse gap-[2px]" style={{ height: height(totals[day]) }}>
                      {series.map((item, index) => {
                        const value = item.values[day] ?? 0
                        if (value <= 0) return null
                        const top = series.slice(index + 1).every((later) => (later.values[day] ?? 0) <= 0)
                        return <div key={item.key} className={cn("w-full min-h-px", item.swatch, top && "rounded-t-[4px]")} style={{ flexGrow: value, flexBasis: 0 }} />
                      })}
                    </div>
                  )
                ) : (
                  <div className="flex h-full w-full max-w-6 items-end gap-[2px]">
                    {series.map((item) => {
                      const value = item.values[day] ?? 0
                      return <div key={item.key} className={cn("min-w-0 flex-1", value > 0 && "rounded-t-[4px]", item.swatch)} style={{ height: height(value) }} />
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div aria-hidden="true" className="mt-1 flex justify-between text-[10px] text-linear-text-tertiary">
            <span>{formatDay(dates[0])}</span>
            {dates.length > 2 && <span>{formatDay(dates[middle])}</span>}
            <span>{formatDay(dates[dates.length - 1])}</span>
          </div>
        </div>
      </div>
      <details className="text-[11px] text-linear-text-secondary">
        <summary className="cursor-pointer select-none text-linear-text-tertiary hover:text-linear-text-secondary">Show as table</summary>
        <div className="mt-2 max-h-64 overflow-y-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{title}, by day</caption>
            <thead>
              <tr className="text-linear-text-tertiary">
                <th scope="col" className="py-1 pr-3 font-medium">Day (UTC)</th>
                {series.map((item) => <th key={item.key} scope="col" className="py-1 pr-3 text-right font-medium">{item.label}</th>)}
                {extra && <th scope="col" className="py-1 pr-3 text-right font-medium">{extra.label}</th>}
              </tr>
            </thead>
            <tbody className="font-mono tabular-nums">
              {dates.map((date, day) => (
                <tr key={date}>
                  <th scope="row" className="py-0.5 pr-3 font-normal">{formatDay(date)}</th>
                  {series.map((item) => <td key={item.key} className="py-0.5 pr-3 text-right">{valueText(item, day)}</td>)}
                  {extra && <td className="py-0.5 pr-3 text-right">{extra.values[day] ?? 0}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {grandTotal === 0 && extraTotal === 0 && <p className="text-[11px] text-linear-text-tertiary">Nothing in this range.</p>}
    </figure>
  )
}
