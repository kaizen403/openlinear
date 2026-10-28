import { enabledFeatures, type FeatureName, type FindingEvidence, type ReviewSeverity } from '../features/types';
import type { EvalManifest } from '../manifest/schema';
import type { TrialRecord } from '../records';
import type { Summary } from '../stats/summary';

/**
 * W21 ablation section of a report: what each arm's features actually
 * applied (from the per-trial receipts) and whether the treatment pays for
 * itself — success difference next to its extra cost, including the
 * reviewer's and the follow-up's sessions (PRD: "ablations justify extra
 * agents", net of cost).
 */

export interface AblationArm {
  configurationId: string;
  features: FeatureName[];
  trials: number;
  /** Trials carrying a feature receipt (a treatment trial without one never got its features). */
  receipts: number;
  /** Agent sessions started over all trials (run + reviewer + follow-up). */
  sessions: number;
  repositoryContext: { sections: number; meanChars: number | null; meanFiles: number | null; missing: Record<string, number> } | null;
  knowledge: { given: number; meanEntries: number | null; meanChars: number | null } | null;
  reviewer: {
    completed: number;
    failed: number;
    skipped: number;
    findings: Record<ReviewSeverity, number>;
    evidence: Record<FindingEvidence, number>;
    actionable: number;
    followUps: number;
    /** Reviewer + follow-up sessions: known spend, and how many of those sessions had no known cost. */
    extraUsd: number;
    extraUnknownSessions: number;
    /** Reviewer + follow-up share of the arm's known spend (null when any cost is unknown). */
    shareOfSpend: number | null;
  } | null;
}

export interface AblationComparison {
  treatment: string;
  baseline: string;
  deltaSuccess: number;
  low: number;
  high: number;
  verdict: string;
  meanCostPerTrial: { treatment: number | null; baseline: number | null };
  /** Treatment − baseline mean cost per trial (null unless both are complete). */
  deltaMeanCostUsd: number | null;
  /** Treatment − baseline resolved trials (same tasks and repeats). */
  extraResolved: number;
  /** Extra spend per extra resolved trial (null unless both spends are complete and the treatment resolved more). */
  usdPerExtraResolved: number | null;
}

export interface AblationSummary {
  arms: AblationArm[];
  comparisons: AblationComparison[];
}

const mean = (values: readonly number[]): number | null => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function buildAblationSummary(manifest: EvalManifest, records: readonly TrialRecord[], primary: Summary): AblationSummary | null {
  if (!manifest.configurations.some((config) => enabledFeatures(config).length > 0)) return null;
  const arms: AblationArm[] = manifest.configurations.map((config) => {
    const mine = records.filter((record) => record.configurationId === config.id);
    const receipts = mine.flatMap((record) => (record.features ? [record.features] : []));
    const features = enabledFeatures(config);
    const context = receipts.flatMap((receipt) => (receipt.repositoryContext ? [receipt.repositoryContext] : []));
    const knowledge = receipts.flatMap((receipt) => (receipt.knowledge ? [receipt.knowledge] : []));
    const reviews = receipts.flatMap((receipt) => (receipt.reviewer ? [receipt.reviewer] : []));
    const extraSessions = receipts.flatMap((receipt) => receipt.phases.filter((phase) => phase.phase !== 'run'));
    const allSessions = receipts.flatMap((receipt) => receipt.phases);
    const missing: Record<string, number> = {};
    for (const entry of context) if (!entry.section) missing[entry.reason ?? 'unknown'] = (missing[entry.reason ?? 'unknown'] ?? 0) + 1;
    const findings: Record<ReviewSeverity, number> = { blocker: 0, major: 0, minor: 0, nit: 0 };
    const evidence: Record<FindingEvidence, number> = { verified: 0, relocated: 0, unverified: 0 };
    for (const review of reviews) {
      for (const finding of review.findings) {
        findings[finding.severity] += 1;
        evidence[finding.evidence] += 1;
      }
    }
    const extraKnown = extraSessions.filter((phase) => phase.costUsd !== null);
    const extraUsd = extraKnown.reduce((sum, phase) => sum + (phase.costUsd ?? 0), 0);
    const allKnown = allSessions.every((phase) => phase.costUsd !== null);
    const armSpend = allSessions.reduce((sum, phase) => sum + (phase.costUsd ?? 0), 0);
    return {
      configurationId: config.id,
      features,
      trials: mine.length,
      receipts: receipts.length,
      // Trials without a receipt (no features) are one session each.
      sessions: mine.length - receipts.length + allSessions.length,
      repositoryContext: features.includes('repositoryContext')
        ? { sections: context.filter((entry) => entry.section).length, meanChars: mean(context.filter((e) => e.section).map((e) => e.chars)), meanFiles: mean(context.filter((e) => e.section).map((e) => e.citations.length)), missing }
        : null,
      knowledge: features.includes('knowledge') ? { given: knowledge.filter((entry) => entry.entries.length > 0).length, meanEntries: mean(knowledge.map((e) => e.entries.length)), meanChars: mean(knowledge.map((e) => e.chars)) } : null,
      reviewer: features.includes('reviewer')
        ? {
            completed: reviews.filter((r) => r.status === 'completed').length,
            failed: reviews.filter((r) => r.status === 'failed').length,
            skipped: reviews.filter((r) => r.status === 'skipped').length,
            findings,
            evidence,
            actionable: reviews.reduce((sum, r) => sum + r.actionable, 0),
            followUps: reviews.filter((r) => r.followUp === 'ran').length,
            extraUsd,
            extraUnknownSessions: extraSessions.length - extraKnown.length,
            shareOfSpend: allKnown && armSpend > 0 ? extraUsd / armSpend : null,
          }
        : null,
    };
  });

  const comparisons: AblationComparison[] = primary.comparisons.map((comparison) => {
    const t = primary.configurations.find((c) => c.configurationId === comparison.treatment);
    const b = primary.configurations.find((c) => c.configurationId === comparison.baseline);
    const meanT = t?.meanCostPerTrialUsd ?? null;
    const meanB = b?.meanCostPerTrialUsd ?? null;
    const extraResolved = (t?.successes ?? 0) - (b?.successes ?? 0);
    const complete = t?.cost.complete === true && b?.cost.complete === true;
    const extraSpend = complete && t && b ? t.cost.knownUsd - b.cost.knownUsd : null;
    return {
      treatment: comparison.treatment,
      baseline: comparison.baseline,
      deltaSuccess: comparison.paired.estimate,
      low: comparison.paired.low,
      high: comparison.paired.high,
      verdict: comparison.verdict,
      meanCostPerTrial: { treatment: meanT, baseline: meanB },
      deltaMeanCostUsd: meanT !== null && meanB !== null ? meanT - meanB : null,
      extraResolved,
      usdPerExtraResolved: extraSpend !== null && extraResolved > 0 ? extraSpend / extraResolved : null,
    };
  });
  return { arms, comparisons };
}

const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const pts = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}` : 'n/a');
const usd = (v: number | null) => (v === null ? 'n/a' : `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(Math.abs(v) < 1 ? 4 : 2)}`);
const num = (v: number | null, digits = 0) => (v === null ? 'n/a' : v.toFixed(digits));
const cell = (text: string) => text.replace(/\|/g, '\\|');

export function renderAblation(summary: AblationSummary, fake: boolean): string[] {
  const out: string[] = ['## Ablation: what the features applied, and the cost of the benefit', ''];
  if (fake) {
    out.push('> **FAKE RUNNERS — these numbers prove the ablation plumbing, not a benefit.** The fake agent\'s success depends on what reached its prompt (a cited file, a knowledge rule) and on the reviewer catching a planted bug; those lifts are programmed into `fakes/ablation.ts`. Real effects need the funded run.', '');
  }
  out.push('| Arm | Features | Trials (with receipt) | Sessions | Repository context | Project knowledge | Reviewer |');
  out.push('|---|---|---:|---:|---|---|---|');
  for (const arm of summary.arms) {
    const context = arm.repositoryContext
      ? `${arm.repositoryContext.sections}/${arm.receipts} given; mean ${num(arm.repositoryContext.meanChars)} chars, ${num(arm.repositoryContext.meanFiles, 1)} files${Object.keys(arm.repositoryContext.missing).length ? `; none: ${Object.entries(arm.repositoryContext.missing).map(([reason, n]) => `${n}× ${reason}`).join(', ')}` : ''}`
      : '—';
    const knowledge = arm.knowledge ? `${arm.knowledge.given}/${arm.receipts} given; mean ${num(arm.knowledge.meanEntries, 1)} entries, ${num(arm.knowledge.meanChars)} chars` : '—';
    const r = arm.reviewer;
    const reviewer = r
      ? `${r.completed} reviewed, ${r.failed} failed, ${r.skipped} skipped; findings B/M/m/n ${r.findings.blocker}/${r.findings.major}/${r.findings.minor}/${r.findings.nit} (verified ${r.evidence.verified}, relocated ${r.evidence.relocated}, unverified ${r.evidence.unverified}); ${r.followUps} follow-up(s); extra sessions ${usd(r.extraUsd)}${r.extraUnknownSessions ? ` + ${r.extraUnknownSessions} unknown` : ''} (${pct(r.shareOfSpend)} of the arm's spend)`
      : '—';
    out.push(`| ${cell(arm.configurationId)} | ${arm.features.join(', ') || 'none (baseline)'} | ${arm.trials} (${arm.receipts}) | ${arm.sessions} | ${cell(context)} | ${cell(knowledge)} | ${cell(reviewer)} |`);
  }
  out.push('');
  if (summary.comparisons.length > 0) {
    out.push('| Treatment | Baseline | Δ success (pts, 95% CI) | Verdict | Mean cost / trial T / B | Δ cost / trial | Extra resolved | USD per extra resolved |');
    out.push('|---|---|---|---|---|---|---:|---|');
    for (const c of summary.comparisons) {
      const perExtra = c.usdPerExtraResolved !== null && c.usdPerExtraResolved < 0 ? 'cheaper and resolves more' : usd(c.usdPerExtraResolved);
      out.push(`| ${cell(c.treatment)} | ${cell(c.baseline)} | ${pts(c.deltaSuccess)} [${pts(c.low)}, ${pts(c.high)}] | ${c.verdict} | ${usd(c.meanCostPerTrial.treatment)} / ${usd(c.meanCostPerTrial.baseline)} | ${usd(c.deltaMeanCostUsd)} | ${c.extraResolved} | ${perExtra} |`);
    }
    out.push('');
    out.push('Costs include every session of a trial (run, reviewer, follow-up). "n/a" cost means some trial\'s cost is unknown (never counted as zero).');
    out.push('');
  }
  return out;
}
