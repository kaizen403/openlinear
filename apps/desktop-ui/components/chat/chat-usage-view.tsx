"use client";

import { useEffect, useId, useState } from "react";
import { Gauge, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fetchModelUsage, type ModelUsageReport } from "@/lib/api/chat";
import { formatApiError } from "@/lib/api/errors";
import type { SessionUsage } from "@/hooks/chat-stream-state";
import { describeBudget, describeReportCost, describeSessionUsage, formatExactCount, formatPercent, formatTokenCount } from "./usage-format";

const REPORT_DAYS = 30;
const MAX_GROUPS = 5;

type ReportState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; report: ModelUsageReport };

/** Model usage over the last 30 days from `GET /api/usage/models` (the caller's own calls). */
export function ModelUsageReportView({ workspaceId }: { workspaceId?: string | null }) {
  const [state, setState] = useState<ReportState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    fetchModelUsage({ days: REPORT_DAYS, ...(workspaceId ? { workspaceId } : {}) })
      .then((report) => {
        if (!cancelled) setState({ kind: "ready", report });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ kind: "error", message: formatApiError(error, "Couldn't load model usage.") });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (state.kind === "loading") {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-linear-text-tertiary" role="status">
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Loading usage…
      </p>
    );
  }
  if (state.kind === "error") {
    return <p className="text-[11px] text-destructive" role="alert">{state.message}</p>;
  }

  const { totals, groups } = state.report;
  const budget = state.report.budget ? describeBudget(state.report.budget) : null;
  const budgetView = budget ? (
    <div
      className={cn(
        "rounded-sm border px-2 py-1.5 text-[11px]",
        state.report.budget?.state === "exceeded"
          ? "border-destructive/50"
          : state.report.budget?.state === "warning"
            ? "border-warning/50"
            : "border-linear-border",
      )}
      data-budget-state={state.report.budget?.state}
    >
      <p className="text-linear-text">{budget.label}</p>
      <ul className="mt-0.5 space-y-0.5 text-linear-text-tertiary">
        {budget.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  ) : null;
  if (totals.calls === 0) {
    return (
      <div className="space-y-2">
        {budgetView}
        <p className="text-[11px] text-linear-text-tertiary">No model calls in the last {REPORT_DAYS} days.</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {budgetView}
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-linear-text-tertiary">Model calls</dt>
        <dd className="text-right text-linear-text">
          {formatExactCount(totals.calls)}
          {totals.callsWithoutUsage > 0 && (
            <span className="text-linear-text-tertiary"> ({totals.callsWithoutUsage} unreported)</span>
          )}
        </dd>
        <dt className="text-linear-text-tertiary">Input tokens</dt>
        <dd className="text-right text-linear-text">{totals.inputTokens === null ? "n/a" : formatTokenCount(totals.inputTokens)}</dd>
        <dt className="text-linear-text-tertiary">Output tokens</dt>
        <dd className="text-right text-linear-text">{totals.outputTokens === null ? "n/a" : formatTokenCount(totals.outputTokens)}</dd>
        <dt className="text-linear-text-tertiary">Cache reads</dt>
        <dd className="text-right text-linear-text">
          {totals.cacheReadTokens === null ? "n/a" : formatTokenCount(totals.cacheReadTokens)}
          <span className="text-linear-text-tertiary"> ({formatPercent(totals.cacheHitRate)} hit)</span>
        </dd>
        <dt className="text-linear-text-tertiary">Cost</dt>
        <dd className="text-right text-linear-text">{describeReportCost(totals)}</dd>
      </dl>
      {groups.length > 0 && (
        <table className="w-full text-[11px]">
          <caption className="sr-only">Usage by model</caption>
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wide text-linear-text-tertiary">
              <th scope="col" className="font-normal">Model</th>
              <th scope="col" className="text-right font-normal">Calls</th>
              <th scope="col" className="text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {groups.slice(0, MAX_GROUPS).map((group) => (
              <tr key={`${group.surface}:${group.provider}:${group.model}`} className="align-top">
                <td className="max-w-[10rem] truncate py-0.5 pr-2 text-linear-text-secondary" title={`${group.provider} · ${group.model} · ${group.surface}`}>
                  {group.model}
                  <span className="block text-[10px] text-linear-text-tertiary">{group.surface}</span>
                </td>
                <td className="py-0.5 text-right text-linear-text">{formatExactCount(group.calls)}</td>
                <td className="py-0.5 pl-2 text-right text-linear-text">{describeReportCost(group)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ChatUsageButtonProps {
  sessionUsage: SessionUsage | null;
  workspaceId?: string | null;
  className?: string;
}

/** Header control: this chat's running total, opening a compact usage view. */
export function ChatUsageButton({ sessionUsage, workspaceId, className }: ChatUsageButtonProps) {
  const [open, setOpen] = useState(false);
  const sessionHeadingId = useId();
  const reportHeadingId = useId();
  const session = sessionUsage ? describeSessionUsage(sessionUsage) : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={session ? `Usage: ${session.label}` : "Usage"}
          className={cn(
            "inline-flex h-8 max-w-[220px] items-center gap-1.5 rounded-sm border border-linear-border bg-linear-bg-secondary px-2.5 text-xs text-linear-text-secondary transition-colors hover:border-linear-border-hover hover:bg-linear-bg-tertiary hover:text-linear-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-linear-accent",
            className,
          )}
        >
          <Gauge className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="hidden truncate sm:inline">{sessionUsage ? `${formatTokenCount(sessionUsage.totalTokens)} tokens` : "Usage"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 border-linear-border bg-linear-bg-secondary p-3 text-linear-text">
        <section aria-labelledby={sessionHeadingId}>
          <h3 id={sessionHeadingId} className="text-[10px] uppercase tracking-wide text-linear-text-tertiary">This chat</h3>
          {session ? (
            <>
              <p className="mt-1 text-xs text-linear-text">{session.label}</p>
              <ul className="mt-1 space-y-0.5 text-[11px] text-linear-text-tertiary">
                {session.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
                <li>Counts every reply in this chat that reported usage.</li>
              </ul>
            </>
          ) : (
            <p className="mt-1 text-[11px] text-linear-text-tertiary">No replies with usage yet in this chat.</p>
          )}
        </section>
        <section aria-labelledby={reportHeadingId}>
          <h3 id={reportHeadingId} className="mb-1 text-[10px] uppercase tracking-wide text-linear-text-tertiary">
            Your model usage, last {REPORT_DAYS} days
          </h3>
          {open && <ModelUsageReportView workspaceId={workspaceId} />}
        </section>
      </PopoverContent>
    </Popover>
  );
}
