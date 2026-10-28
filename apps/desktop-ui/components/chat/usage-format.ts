import type { ChatBudgetDimension, ChatBudgetScope, ChatBudgetStatus, ChatCostBasis, ChatTurnUsage, ModelUsageTotals } from "@/lib/api/chat";
import type { SessionUsage } from "@/hooks/chat-stream-state";

/**
 * Usage copy for Home Chat. Unknown cost always reads "cost unknown" — it is
 * never rendered as $0 — and estimated costs (operator price snapshot) are
 * marked with "≈".
 */

const UNKNOWN_COST = "cost unknown";

export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(abs < 10_000_000 ? 2 : 1)}M`;
}

export function formatExactCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** Dollars: two decimals from $1, up to four below it (chat turns cost fractions of a cent). */
export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.0001) return "< $0.0001";
  if (Math.abs(value) >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4).replace(/0{1,2}$/, "")}`;
}

/** Turn cost: "cost unknown", "$0.0123" (provider-reported) or "≈ $0.0123" (estimated). */
export function formatTurnCost(usage: Pick<ChatTurnUsage, "costUsd" | "costBasis">): string {
  if (typeof usage.costUsd !== "number" || !Number.isFinite(usage.costUsd)) return UNKNOWN_COST;
  const estimated = usage.costBasis !== "provider_reported";
  return `${estimated ? "≈ " : ""}${formatUsd(usage.costUsd)}`;
}

function costBasisLabel(basis: ChatCostBasis | undefined): string {
  switch (basis) {
    case "provider_reported":
      return "reported by the provider";
    case "estimated":
      return "estimated from the configured price list";
    case "mixed":
      return "part reported, part estimated";
    default:
      return "no price available";
  }
}

export interface UsageCopy {
  /** Compact one-liner. */
  label: string;
  /** Full sentence(s) for the expanded view and screen readers. */
  lines: string[];
}

export function describeTurnUsage(usage: ChatTurnUsage): UsageCopy {
  const parts = [`${formatTokenCount(usage.totalTokens)} tokens`];
  const cacheRead = typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : null;
  if (cacheRead !== null && cacheRead > 0) parts.push(`${formatTokenCount(cacheRead)} cached`);
  parts.push(formatTurnCost(usage));

  const lines = [
    `Input ${formatExactCount(usage.inputTokens)} tokens${cacheRead !== null ? ` (${formatExactCount(cacheRead)} read from cache)` : ""}`,
    `Output ${formatExactCount(usage.outputTokens)} tokens${typeof usage.reasoningTokens === "number" && usage.reasoningTokens > 0 ? ` (${formatExactCount(usage.reasoningTokens)} reasoning)` : ""}`,
  ];
  if (typeof usage.modelCalls === "number") {
    lines.push(`${usage.modelCalls} model call${usage.modelCalls === 1 ? "" : "s"}${usage.coverage === "partial" ? "; some did not report usage, so totals are a lower bound" : ""}`);
  }
  lines.push(
    typeof usage.costUsd === "number"
      ? `Cost ${formatTurnCost(usage)} (${costBasisLabel(usage.costBasis)})`
      : "Cost unknown: no price is configured for this model",
  );
  return { label: parts.join(" · "), lines };
}

export function describeSessionUsage(usage: SessionUsage): UsageCopy {
  const tokens = `${usage.tokensIncomplete || usage.turnsWithoutUsage > 0 ? "≥ " : ""}${formatTokenCount(usage.totalTokens)} tokens`;
  let cost: string;
  if (usage.knownCostUsd === null) cost = UNKNOWN_COST;
  else if (usage.costIncomplete) cost = `≥ ${formatUsd(usage.knownCostUsd)} (some cost unknown)`;
  else cost = `${usage.costEstimated ? "≈ " : ""}${formatUsd(usage.knownCostUsd)}`;

  const lines = [
    `${usage.turns} repl${usage.turns === 1 ? "y" : "ies"} with usage: ${formatExactCount(usage.inputTokens)} input, ${formatExactCount(usage.outputTokens)} output tokens`,
  ];
  if (usage.cacheReadTokens !== null) lines.push(`${formatExactCount(usage.cacheReadTokens)} input tokens read from cache`);
  if (usage.turnsWithoutUsage > 0) {
    lines.push(`${usage.turnsWithoutUsage} repl${usage.turnsWithoutUsage === 1 ? "y" : "ies"} reported no usage (failed, stopped or not metered)`);
  }
  lines.push(`Cost: ${cost}`);
  return { label: `${tokens} · ${cost}`, lines };
}

export function describeReportCost(totals: ModelUsageTotals): string {
  const { knownUsd, coverage, byBasis } = totals.cost;
  if (knownUsd === null || coverage === "none") return UNKNOWN_COST;
  if (coverage === "partial") {
    return `≥ ${formatUsd(knownUsd)} (${byBasis.unknown} call${byBasis.unknown === 1 ? "" : "s"} with unknown cost)`;
  }
  return `${byBasis.estimated > 0 ? "≈ " : ""}${formatUsd(knownUsd)}`;
}

function describeDimension(dimension: ChatBudgetDimension, unit: "usd" | "tokens"): string {
  const format = unit === "usd" ? formatUsd : (value: number) => `${formatTokenCount(value)} tokens`;
  const lowerBound = dimension.coverage === "partial" ? "≥ " : "";
  const held = dimension.held > 0 ? `, ${format(dimension.held)} reserved by replies in progress` : "";
  const unpriced = dimension.coverage === "partial"
    ? ` (${dimension.uncountedCalls} call${dimension.uncountedCalls === 1 ? "" : "s"} ${unit === "usd" ? "without a price" : "without token counts"})`
    : "";
  return `${lowerBound}${format(dimension.spent)} of ${format(dimension.limit)} used${held}${unpriced}`;
}

const STATE_COPY: Record<ChatBudgetScope["state"], string> = {
  unlimited: "no limit",
  ok: "within the limit",
  warning: "almost used up",
  exceeded: "used up",
};

function describeScope(label: string, scope: ChatBudgetScope): string[] {
  if (scope.state === "unlimited") return [];
  if (!scope.amountsVisible) return [`${label}: ${STATE_COPY[scope.state]}`];
  const lines: string[] = [];
  if (scope.usd) lines.push(`${label}: ${describeDimension(scope.usd, "usd")}`);
  if (scope.tokens) lines.push(`${label}: ${describeDimension(scope.tokens, "tokens")}`);
  return lines;
}

/**
 * Monthly chat budget lines for the usage view. Null when no cap applies.
 * Workspace amounts are only present for owners/admins; members see the state.
 */
export function describeBudget(budget: ChatBudgetStatus): UsageCopy | null {
  if (budget.state === "unlimited") return null;
  const resets = new Date(budget.period.end).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const lines = [...describeScope("You", budget.user), ...describeScope("Workspace", budget.workspace)];
  const hasUsdCap = Boolean(budget.user.usd || budget.workspace.usd) || !budget.workspace.amountsVisible;
  if (!budget.costPriceable && hasUsdCap) {
    lines.push(budget.unknownCostPolicy === "block"
      ? "This model has no price, so replies are blocked while a spending cap applies."
      : "This model has no price, so spending caps can't limit replies; token caps still apply.");
  }
  lines.push(`Resets ${resets}.`);
  const label = budget.state === "exceeded"
    ? "Chat budget used up"
    : budget.state === "warning"
      ? "Chat budget almost used up"
      : "Chat budget within limits";
  return { label, lines };
}

export function formatPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "n/a";
  return `${Math.round(rate * 100)}%`;
}
