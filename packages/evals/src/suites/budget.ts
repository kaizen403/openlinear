/**
 * Funded-run budget (PRD §10): total = tasks × repeats × configurations ×
 * measured mean cost per trial, plus a stated contingency. Gate runs
 * (reference/oracle and empty-patch/nop) use no inference and cost only
 * compute. Mean costs must come from a measured pilot; the figures in docs
 * are orientation only, never spending authorisation.
 */

export interface BudgetConfiguration {
  id: string;
  /** Measured (or, before a pilot, assumed) mean inference cost per trial in USD. */
  meanCostUsd: number;
  /** Mean wall-clock minutes per trial (for time planning). */
  meanMinutes?: number;
  /** Where the mean comes from (pilot run id, public leaderboard row + date, …). */
  basis: string;
}

export interface BudgetInput {
  tasks: number;
  repeats: number;
  configurations: readonly BudgetConfiguration[];
  /** e.g. 0.25 for +25 %. */
  contingency: number;
  /** Concurrent trials, for the wall-clock estimate. */
  concurrency?: number;
  /** Per-task inference cap (USD) used to bound the worst case. */
  perTaskCapUsd?: number | null;
  /** Headroom over the cap for in-flight overshoot, e.g. 0.1. */
  capHeadroom?: number;
}

export interface BudgetEstimate {
  formula: string;
  perConfiguration: Array<{ id: string; trials: number; inferenceUsd: number; worstCaseUsd: number | null; basis: string; hours: number | null }>;
  trials: number;
  subtotalUsd: number;
  contingencyUsd: number;
  totalUsd: number;
  /** Every trial hitting the per-task cap (plus headroom): the ceiling a funder should approve against. */
  worstCaseUsd: number | null;
  wallClockHours: number | null;
  gateTrials: number;
}

export function estimateBudget(input: BudgetInput): BudgetEstimate {
  if (input.tasks < 1 || input.repeats < 1 || input.configurations.length === 0) throw new Error('tasks, repeats and configurations must be positive');
  if (input.contingency < 0) throw new Error('contingency must be ≥ 0');
  const trialsPerConfig = input.tasks * input.repeats;
  const cap = input.perTaskCapUsd ?? null;
  const headroom = 1 + (input.capHeadroom ?? 0.1);
  const perConfiguration = input.configurations.map((config) => ({
    id: config.id,
    trials: trialsPerConfig,
    inferenceUsd: trialsPerConfig * config.meanCostUsd,
    worstCaseUsd: cap === null ? null : trialsPerConfig * cap * headroom,
    basis: config.basis,
    hours: config.meanMinutes === undefined ? null : (trialsPerConfig * config.meanMinutes) / 60,
  }));
  const subtotalUsd = perConfiguration.reduce((sum, c) => sum + c.inferenceUsd, 0);
  const contingencyUsd = subtotalUsd * input.contingency;
  const hours = perConfiguration.every((c) => c.hours !== null) ? perConfiguration.reduce((sum, c) => sum + (c.hours ?? 0), 0) : null;
  return {
    formula: `${input.tasks} tasks × ${input.repeats} repeats × Σ(${input.configurations.length} configurations' mean cost per trial) × (1 + ${input.contingency} contingency)`,
    perConfiguration,
    trials: trialsPerConfig * input.configurations.length,
    subtotalUsd,
    contingencyUsd,
    totalUsd: subtotalUsd + contingencyUsd,
    worstCaseUsd: cap === null ? null : perConfiguration.reduce((sum, c) => sum + (c.worstCaseUsd ?? 0), 0),
    wallClockHours: hours === null ? null : hours / Math.max(1, input.concurrency ?? 1),
    gateTrials: input.tasks * 2,
  };
}

export function renderBudget(estimate: BudgetEstimate): string {
  const usd = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  const lines = [
    `Formula: ${estimate.formula}`,
    '',
    '| Configuration | Trials | Mean-cost estimate | Worst case (cap + headroom) | Basis |',
    '|---|---:|---:|---:|---|',
    ...estimate.perConfiguration.map((c) => `| ${c.id} | ${c.trials} | ${usd(c.inferenceUsd)} | ${c.worstCaseUsd === null ? 'n/a' : usd(c.worstCaseUsd)} | ${c.basis} |`),
    '',
    `Subtotal ${usd(estimate.subtotalUsd)} + contingency ${usd(estimate.contingencyUsd)} = **${usd(estimate.totalUsd)}** for ${estimate.trials} trials.`,
    estimate.worstCaseUsd === null ? '' : `Approve against the worst case: ${usd(estimate.worstCaseUsd)} (every trial stops at the per-task cap).`,
    estimate.wallClockHours === null ? '' : `Wall clock ≈ ${estimate.wallClockHours.toFixed(1)} h at the stated concurrency.`,
    `Plus ${estimate.gateTrials} zero-inference gate trials (reference + empty patch).`,
  ];
  return lines.filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');
}
