"use client"

import type { ReactNode } from "react"
import { AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  formatCount,
  formatDuration,
  formatKnownCost,
  formatRate,
  formatUsd,
  plural,
  type Insights,
  type InsightsRunGroup,
} from "@/lib/api/insights"
import { DailyColumns, ProportionBar, type ChartSeries } from "./insights-charts"

/**
 * W15b insights document → stat tiles, outcome bar, daily charts, runner and
 * model tables, delivery. Presentational only (InsightsPanel fetches). Cost is
 * always "known spend" with the unknown-cost runs said next to it: a run
 * without a recorded price is never shown as $0, and a runner, model, day or
 * range where no run recorded one reads "unknown".
 */

/** Outcome marks, bottom-up; the order keeps green and red apart (CVD). */
const OUTCOMES = [
  { key: "succeeded", label: "Succeeded", swatch: "bg-success" },
  { key: "cancelled", label: "Cancelled", swatch: "bg-status-cancelled" },
  { key: "failed", label: "Failed", swatch: "bg-danger" },
  { key: "recoveryRequired", label: "Needs recovery", swatch: "bg-warning" },
  { key: "inProgress", label: "In progress", swatch: "bg-info" },
] as const

export function StatTile({ label, value, detail, warning }: { label: string; value: string; detail?: ReactNode; warning?: string | null }) {
  return (
    <div className="rounded-sm border border-linear-border bg-linear-bg-secondary p-3">
      <div className="text-[11px] font-medium text-linear-text-tertiary">{label}</div>
      <div className="mt-1 text-xl font-semibold text-linear-text">{value}</div>
      {detail && <div className="mt-0.5 text-[11px] text-linear-text-secondary">{detail}</div>}
      {warning && (
        <div className="mt-1 flex items-start gap-1 text-[11px] text-linear-text-secondary">
          <AlertTriangle aria-hidden="true" className="mt-px h-3 w-3 shrink-0 text-warning" />
          <span>{warning}</span>
        </div>
      )}
    </div>
  )
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div>
        <h2 className="text-sm font-semibold text-linear-text">{title}</h2>
        {description && <p className="mt-0.5 text-[11px] text-linear-text-tertiary">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-sm border border-linear-border bg-linear-bg-secondary p-4", className)}>{children}</div>
}

function GroupTable({ title, groups }: { title: string; groups: InsightsRunGroup[] }) {
  return (
    <Panel className="overflow-x-auto p-0">
      <table className="w-full text-sm">
        <caption className="px-4 pb-2 pt-3 text-left text-sm font-semibold text-linear-text">{title}</caption>
        <thead>
          <tr className="border-b border-linear-border text-[11px] text-linear-text-tertiary">
            <th scope="col" className="px-4 py-2 text-left font-medium">Name</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Runs</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Success</th>
            <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">Median</th>
            <th scope="col" className="hidden px-3 py-2 text-right font-medium md:table-cell">p90</th>
            <th scope="col" className="px-4 py-2 text-right font-medium">Known cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-layer-divider font-mono text-[12px] tabular-nums">
          {groups.map((group) => (
            <tr key={group.key}>
              <th scope="row" className="max-w-[16rem] truncate px-4 py-2 text-left font-sans font-normal text-linear-text" title={group.key}>{group.key}</th>
              <td className="px-3 py-2 text-right text-linear-text-secondary">{group.runs}</td>
              <td className="px-3 py-2 text-right text-linear-text-secondary">{formatRate(group.successRate)}</td>
              <td className="hidden px-3 py-2 text-right text-linear-text-secondary md:table-cell">{formatDuration(group.medianMs)}</td>
              <td className="hidden px-3 py-2 text-right text-linear-text-secondary md:table-cell">{formatDuration(group.p90Ms)}</td>
              <td className={cn("px-4 py-2 text-right", group.costUsd === null ? "text-linear-text-tertiary" : "text-linear-text")}>
                {formatKnownCost(group.costUsd, group.runs)}
                {group.costUsd !== null && group.unknownCostRuns > 0 && <span className="ml-1 text-linear-text-tertiary">+ {group.unknownCostRuns} unknown</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  )
}

export function InsightsView({ insights }: { insights: Insights }) {
  const { runs, delivery, range } = insights
  const dates = runs.daily.map((day) => day.date)
  const period = `the last ${range.days} days`
  const unknownCost = runs.cost.unknownCostRuns > 0
    ? `${plural(runs.cost.unknownCostRuns, "run")} with no recorded price ${runs.cost.unknownCostRuns === 1 ? "is" : "are"} not included`
    : null

  const runSeries: ChartSeries[] = [
    { key: "succeeded", label: "Succeeded", swatch: "bg-success", values: runs.daily.map((day) => day.succeeded) },
    { key: "cancelled", label: "Cancelled", swatch: "bg-status-cancelled", values: runs.daily.map((day) => day.cancelled) },
    { key: "failed", label: "Failed", swatch: "bg-danger", values: runs.daily.map((day) => day.failed) },
    { key: "recoveryRequired", label: "Needs recovery", swatch: "bg-warning", values: runs.daily.map((day) => day.recoveryRequired) },
    {
      key: "inProgress",
      label: "In progress",
      swatch: "bg-info",
      values: runs.daily.map((day) => Math.max(0, day.runs - day.succeeded - day.cancelled - day.failed - day.recoveryRequired)),
    },
  ]

  return (
    <div className="space-y-8">
      <Section
        title="Agent runs"
        description={`Runs started in ${period}${insights.scope.kind === "workspace" ? ` across ${plural(insights.scope.projects, "project")}` : ""}. Days are UTC.`}
      >
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label="Runs"
            value={formatCount(runs.total)}
            detail={`${runs.finished} finished${runs.outcomes.inProgress > 0 ? ` · ${runs.outcomes.inProgress} in progress` : ""}`}
          />
          <StatTile
            label="Success rate"
            value={formatRate(runs.successRate)}
            detail={runs.finished > 0 ? `${runs.outcomes.succeeded} of ${runs.finished} finished` : "No finished runs"}
            warning={runs.outcomes.recoveryRequired > 0 ? `${plural(runs.outcomes.recoveryRequired, "run")} need${runs.outcomes.recoveryRequired === 1 ? "s" : ""} recovery` : null}
          />
          <StatTile
            label="Verification pass rate"
            value={formatRate(runs.verification.passRate)}
            detail={`${runs.verification.passed} passed · ${runs.verification.failed} failed · ${runs.verification.unverified} unverified`}
          />
          <StatTile
            label="Pull request rate"
            value={formatRate(runs.publication.rate)}
            detail={plural(runs.publication.published, "pull request")}
          />
          <StatTile
            label="Run duration (median)"
            value={formatDuration(runs.duration.medianMs)}
            detail={`p90 ${formatDuration(runs.duration.p90Ms)}`}
          />
          <StatTile
            label="Known cost"
            value={formatKnownCost(runs.cost.runsWithCost > 0 ? runs.cost.knownUsd : null, runs.total)}
            detail={runs.cost.runsWithCost > 0 ? `from ${plural(runs.cost.runsWithCost, "run")} with a price` : "No run recorded a price"}
            warning={unknownCost}
          />
          <StatTile
            label="Tokens"
            value={`${formatCount(runs.tokens.input)} in`}
            detail={`${formatCount(runs.tokens.output)} out · ${plural(runs.tokens.runsWithTokens, "run")} reported`}
          />
          <StatTile
            label="Cached input"
            value={formatCount(runs.tokens.cachedInput)}
            detail={`${formatCount(runs.tokens.reasoning)} reasoning`}
          />
        </div>

        {runs.total > 0 ? (
          <>
            <Panel>
              <h3 className="mb-2 text-sm font-semibold text-linear-text">Outcomes</h3>
              <ProportionBar
                label="Run outcomes"
                parts={OUTCOMES.map((outcome) => ({ key: outcome.key, label: outcome.label, swatch: outcome.swatch, value: runs.outcomes[outcome.key] }))}
              />
            </Panel>
            <div className="grid gap-3 xl:grid-cols-2">
              <Panel>
                <DailyColumns title="Runs per day" dates={dates} series={runSeries} mode="stacked" />
              </Panel>
              <Panel>
                <DailyColumns
                  title="Known cost per day"
                  description="Recorded prices only; runs without one are listed in the table."
                  dates={dates}
                  series={[{
                    key: "cost",
                    label: "Cost",
                    swatch: "bg-linear-accent",
                    values: runs.daily.map((day) => day.costUsd ?? 0),
                    text: runs.daily.map((day) => formatKnownCost(day.costUsd, day.runs)),
                  }]}
                  mode="stacked"
                  format={formatUsd}
                  extra={{ label: "Runs with unknown cost", values: runs.daily.map((day) => day.unknownCostRuns) }}
                />
              </Panel>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              <GroupTable title="By runner" groups={runs.byRunner} />
              <GroupTable title="By model" groups={runs.byModel} />
            </div>
          </>
        ) : (
          <Panel>
            <p className="text-sm text-linear-text-secondary">No agent runs in {period}.</p>
          </Panel>
        )}
      </Section>

      <Section title="Delivery" description={`Issues created and completed in ${period}.`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Created" value={formatCount(delivery.created)} />
          <StatTile
            label="Completed"
            value={formatCount(delivery.completed)}
            warning={delivery.completedUntracked > 0 ? `${plural(delivery.completedUntracked, "more issue")} done without a recorded date` : null}
          />
          <StatTile
            label="Cycle time (median)"
            value={formatDuration(delivery.cycleTime.medianMs)}
            detail={delivery.cycleTime.samples > 0 ? `p90 ${formatDuration(delivery.cycleTime.p90Ms)} · created to done` : "No completed issues"}
          />
          <StatTile label="Blocked now" value={formatCount(delivery.blockedNow)} detail={`of ${plural(delivery.openNow, "open issue")}`} />
          <StatTile
            label="Plans approved"
            value={formatCount(delivery.plans.plansApproved)}
            detail={`${plural(delivery.plans.approvals, "approval")} · ${delivery.plans.awaitingReview} awaiting review`}
          />
        </div>
        <Panel>
          <DailyColumns
            title="Created and completed per day"
            dates={delivery.daily.map((day) => day.date)}
            series={[
              { key: "created", label: "Created", swatch: "bg-info", values: delivery.daily.map((day) => day.created) },
              { key: "completed", label: "Completed", swatch: "bg-success", values: delivery.daily.map((day) => day.completed) },
            ]}
            mode="grouped"
          />
        </Panel>
      </Section>

      <details className="rounded-sm border border-linear-border bg-linear-bg-secondary p-4 text-[12px] text-linear-text-secondary">
        <summary className="cursor-pointer select-none text-sm font-semibold text-linear-text">How these numbers are counted</summary>
        <dl className="mt-3 space-y-2">
          {Object.entries(insights.notes).map(([key, note]) => (
            <div key={key}>
              <dt className="font-mono text-[11px] text-linear-text-tertiary">{key}</dt>
              <dd>{note}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  )
}
