"use client"

import { useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { BarChart3, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { describeApiError } from "@/lib/api/errors"
import { fetchInsights, INSIGHTS_RANGES, insightsKeys, type Insights, type InsightsRange, type InsightsScope } from "@/lib/api/insights"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { InsightsView } from "./insights-view"

/**
 * W15b: insights for a project or a workspace, with a 7 / 30 / 90 day switch.
 * The previous range stays on screen while the next one loads; the server
 * computes everything (bounded aggregate queries), so a refetch is cheap.
 */

const RANGE_LABELS: Record<InsightsRange, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days" }

export function RangeSwitch({ value, onChange, disabled }: { value: InsightsRange; onChange: (range: InsightsRange) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Time range" className="inline-flex rounded-sm border border-linear-border p-0.5">
      {INSIGHTS_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          role="radio"
          aria-checked={value === range}
          disabled={disabled}
          onClick={() => onChange(range)}
          className={cn(
            "rounded-[3px] px-2.5 py-1 text-xs transition-colors",
            value === range ? "bg-linear-bg-tertiary text-linear-text" : "text-linear-text-secondary hover:text-linear-text",
          )}
        >
          {RANGE_LABELS[range]}
        </button>
      ))}
    </div>
  )
}

/** Nothing happened in the range and nothing is open: say so instead of a wall of zeros. */
export function isEmptyInsights(insights: Insights): boolean {
  const { runs, delivery } = insights
  return runs.total === 0 && delivery.created === 0 && delivery.completed === 0 && delivery.completedUntracked === 0
    && delivery.openNow === 0 && delivery.plans.approvals === 0 && delivery.plans.awaitingReview === 0
}

export function InsightsPanel({ scope, initialRange = "30d" }: { scope: InsightsScope; initialRange?: InsightsRange }) {
  const client = useAppQueryClient()
  const [range, setRange] = useState<InsightsRange>(initialRange)
  const query = useQuery({
    queryKey: insightsKeys.forScope(scope, range),
    queryFn: () => fetchInsights(scope, range),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  }, client)
  const data = query.data
  const switching = query.isFetching && query.isPlaceholderData

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <RangeSwitch value={range} onChange={setRange} />
        {switching && <Loader2 aria-label="Loading" className="h-3.5 w-3.5 animate-spin text-linear-text-tertiary" />}
        {data && <span className="text-[11px] text-linear-text-tertiary">Updated {new Date(data.range.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
      </div>
      {query.isPending ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading insights">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-20 rounded-sm" />)}
          </div>
          <Skeleton className="h-48 rounded-sm" />
        </div>
      ) : query.isError && !data ? (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-sm border border-linear-border bg-linear-bg-secondary p-4">
          <p className="text-sm text-linear-text-secondary">{describeApiError(query.error, "Couldn't load insights.").message}</p>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
        </div>
      ) : data && isEmptyInsights(data) ? (
        <EmptyState
          icon={BarChart3}
          title={`Nothing to show for the last ${data.range.days} days`}
          description="Insights appear once issues are created or agents run. Try a longer range."
        />
      ) : data ? (
        <InsightsView insights={data} />
      ) : null}
    </div>
  )
}
