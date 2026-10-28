import type { DriftNotice, EvalManifest } from '../manifest/schema';
import { manifestDigest } from '../manifest/schema';
import type { TaskGateResult } from '../grading/verifier';
import { adjudicatedView, intentToRunView, type TrialRecord } from '../records';
import { type Summary, summarize } from '../stats/summary';
import { type AblationSummary, buildAblationSummary, renderAblation } from './ablation';

export const REPORT_SCHEMA_VERSION = 'openlinear.eval.report/v1' as const;

export interface EvalReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAt: string;
  manifest: { id: string; title: string; digest: string; purpose: string; track: string; repeats: number };
  /** True when any configuration replayed recordings: the numbers are a pipeline check, not a benchmark. */
  fake: boolean;
  gates: Array<{ taskId: string; ok: boolean; referencePasses: boolean; emptyPatchFails: boolean }>;
  excludedTasks: string[];
  primary: Summary;
  adjudicated: Summary;
  infraReruns: number;
  drift: DriftNotice[];
  caveats: string[];
  wallClockMs: number;
  /** W21: present when a configuration enables features (intent-to-run view). */
  ablation?: AblationSummary;
}

export function buildReport(input: {
  manifest: EvalManifest;
  records: readonly TrialRecord[];
  gates: readonly TaskGateResult[];
  drift: readonly DriftNotice[];
  wallClockMs: number;
  now?: Date;
  /** Extra caveats from the run (e.g. in-sample knowledge entries). */
  notes?: readonly string[];
}): EvalReport {
  const { manifest } = input;
  const fake = manifest.configurations.some((config) => config.runner.mode === 'fake');
  const caveats: string[] = [];
  if (fake) caveats.push('FAKE RUNNERS: every configuration replayed recorded/synthetic trajectories. These numbers validate the harness pipeline only and are NOT a benchmark result.');
  if (manifest.purpose !== 'release') caveats.push(`Purpose is "${manifest.purpose}": not release evidence (release needs ≥5 fresh trials per task/configuration on frozen public suites plus the sealed holdout).`);
  if (manifest.analysis.practicalThresholdPts === null) caveats.push('No practical improvement threshold was preregistered; "improvement" only means the paired interval excludes zero.');
  const blocking = input.drift.filter((d) => d.severity === 'blocking');
  if (blocking.length > 0) caveats.push(`${blocking.length} blocking drift notice(s): results are not comparable with runs under the original manifest.`);
  for (const config of manifest.configurations) {
    if (config.runner.mode === 'real' && config.harness === 'native' && config.runner.id === 'opencode') caveats.push(`${config.id}: OpenCode's JSON stream does not report the model id; the snapshot is unverifiable from the trajectory.`);
  }
  const primary = summarize(intentToRunView(input.records), manifest, 'intent-to-run');
  const ablation = buildAblationSummary(manifest, intentToRunView(input.records), primary);
  if (ablation && fake) caveats.push('FAKE ABLATION: the treatment effects are programmed into the fake runners (fakes/ablation.ts); they show that prompt sections, the reviewer pass, cost accounting and paired statistics work end to end, not that any feature helps.');
  caveats.push(...(input.notes ?? []));
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAt: (input.now ?? new Date()).toISOString(),
    manifest: { id: manifest.id, title: manifest.title, digest: manifestDigest(manifest), purpose: manifest.purpose, track: manifest.track, repeats: manifest.repeats },
    fake,
    gates: input.gates.map((g) => ({ taskId: g.taskId, ok: g.ok, referencePasses: g.referencePasses, emptyPatchFails: g.emptyPatchFails })),
    excludedTasks: input.gates.filter((g) => !g.ok).map((g) => g.taskId),
    primary,
    adjudicated: summarize(adjudicatedView(input.records), manifest, 'adjudicated'),
    infraReruns: input.records.filter((r) => r.attempt > 1).length,
    drift: [...input.drift],
    caveats,
    wallClockMs: input.wallClockMs,
    ...(ablation ? { ablation } : {}),
  };
}

const pct = (v: number) => (Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : 'n/a');
const pts = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}` : 'n/a');
const ms = (v: number | null) => (v === null || !Number.isFinite(v) ? 'n/a' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const usd = (v: number | null) => (v === null ? 'unknown' : `$${v.toFixed(v < 1 ? 4 : 2)}`);
const cell = (text: string) => text.replace(/\|/g, '\\|');

const OUTCOME_GLYPH: Record<string, string> = { pass: 'P', fail: 'F', timeout: 'T', infra: 'I', refusal: 'R', safety: 'S' };

function summaryTable(summary: Summary): string[] {
  const lines = [
    '| Configuration | Mode | Trials | Tasks | Success (95% CI, task-cluster bootstrap) | Fail | Timeout | Infra | Refusal | Safety | Cost / resolved | All-task spend | p50 / p95 task→artifact |',
    '|---|---|---:|---:|---|---:|---:|---:|---:|---:|---|---|---|',
  ];
  for (const c of summary.configurations) {
    const spend = c.cost.complete ? usd(c.cost.knownUsd) : c.cost.knownTrials > 0 ? `≥ ${usd(c.cost.knownUsd)} (${c.cost.unknownTrials} unknown)` : 'unknown';
    const perResolved = c.costPerResolved.usd === null ? 'n/a' : `${c.costPerResolved.basis === 'lower-bound' ? '≥ ' : ''}${usd(c.costPerResolved.usd)}`;
    lines.push(
      `| ${cell(c.configurationId)} | ${c.runnerMode} | ${c.trials} | ${c.tasks} | ${pct(c.success.estimate)} [${pct(c.success.low)}, ${pct(c.success.high)}] | ${c.outcomes.fail} | ${c.outcomes.timeout} | ${c.outcomes.infra} | ${c.outcomes.refusal} | ${c.outcomes.safety} | ${perResolved} | ${spend} | ${ms(c.taskToArtifact.p50Ms)} / ${ms(c.taskToArtifact.p95Ms)} (${c.taskToArtifact.censored} censored) |`,
    );
  }
  return lines;
}

export function renderMarkdown(report: EvalReport): string {
  const out: string[] = [];
  out.push(`# Evaluation report: ${report.manifest.title}`);
  out.push('');
  if (report.fake) out.push('> **FAKE RUNNERS — pipeline check, not a benchmark.** All configurations replayed recorded/synthetic trajectories; no model was contacted.', '');
  out.push(`- Manifest: \`${report.manifest.id}\` (digest \`${report.manifest.digest.slice(0, 16)}…\`), purpose **${report.manifest.purpose}**, track **${report.manifest.track}**, ${report.manifest.repeats} repeat(s) per task × configuration`);
  out.push(`- Generated ${report.generatedAt}; wall clock ${ms(report.wallClockMs)}`);
  out.push(`- Task gates (reference passes, empty patch fails): ${report.gates.filter((g) => g.ok).length}/${report.gates.length} ok${report.excludedTasks.length ? `; excluded: ${report.excludedTasks.join(', ')}` : ''}`);
  out.push(`- Infra reruns (predeclared rule): ${report.infraReruns}`);
  out.push('');
  out.push('## Primary result (intent-to-run: every scheduled first attempt in the denominator)');
  out.push('');
  out.push(...summaryTable(report.primary));
  out.push('');
  if (report.primary.comparisons.length > 0) {
    out.push('## Paired comparisons (treatment − baseline, percentage points)');
    out.push('');
    out.push('| Treatment | Baseline | Tasks | Δ success | 95% CI | Treatment better / baseline better / tie | Verdict |');
    out.push('|---|---|---:|---:|---|---|---|');
    for (const c of report.primary.comparisons) {
      out.push(`| ${cell(c.treatment)} | ${cell(c.baseline)} | ${c.paired.tasks} | ${pts(c.paired.estimate)} | [${pts(c.paired.low)}, ${pts(c.paired.high)}] | ${c.paired.treatmentBetter} / ${c.paired.baselineBetter} / ${c.paired.ties} | ${c.verdict} (${c.note}) |`);
    }
    out.push('');
  }
  if (report.ablation) out.push(...renderAblation(report.ablation, report.fake));
  out.push('## Adjudicated view (after predeclared infra reruns)');
  out.push('');
  out.push(...summaryTable(report.adjudicated));
  out.push('');
  out.push('## Per-task outcomes (P pass, F fail, T timeout/budget, I infra, R refusal, S safety; repeat order)');
  out.push('');
  const configIds = report.primary.configurations.map((c) => c.configurationId);
  out.push(`| Task | Category | Sealed | ${configIds.map(cell).join(' | ')} |`);
  out.push(`|---|---|---|${configIds.map(() => '---').join('|')}|`);
  for (const row of report.primary.tasks) {
    out.push(`| ${cell(row.taskId)} | ${row.category} | ${row.sealed ? 'yes' : ''} | ${configIds.map((id) => (row.outcomes[id] ?? []).map((o) => OUTCOME_GLYPH[o] ?? '?').join(' ')).join(' | ')} |`);
  }
  out.push('');
  out.push('## Cost and usage basis');
  out.push('');
  out.push('| Configuration | Cost basis counts | Tokens in / out / cache-read / cache-write / reasoning | Trials without usage | Mean cost / trial |');
  out.push('|---|---|---|---:|---|');
  for (const c of report.primary.configurations) {
    const bases = Object.entries(c.cost.byBasis)
      .filter(([, n]) => n > 0)
      .map(([basis, n]) => `${basis}: ${n}`)
      .join(', ');
    out.push(`| ${cell(c.configurationId)} | ${bases || 'none'} | ${c.tokens.input} / ${c.tokens.output} / ${c.tokens.cacheRead} / ${c.tokens.cacheWrite} / ${c.tokens.reasoning} | ${c.tokens.unknownTrials} | ${usd(c.meanCostPerTrialUsd)} |`);
  }
  out.push('');
  out.push('Token categories are provider-raw per configuration (OpenAI-family: cache-read ⊂ input; Anthropic/OpenCode: disjoint) and are not comparable across families. Unknown cost is never counted as zero.');
  out.push('');
  out.push('## Latency (all trials, censored included)');
  out.push('');
  out.push('| Configuration | Task→artifact p50 / p95 | Agent p50 / p95 | First action p50 / p95 |');
  out.push('|---|---|---|---|');
  for (const c of report.primary.configurations) {
    out.push(`| ${cell(c.configurationId)} | ${ms(c.taskToArtifact.p50Ms)} / ${ms(c.taskToArtifact.p95Ms)} | ${ms(c.agentLatency.p50Ms)} / ${ms(c.agentLatency.p95Ms)} | ${ms(c.firstAction.p50Ms)} / ${ms(c.firstAction.p95Ms)} |`);
  }
  out.push('');
  out.push('## Drift notices');
  out.push('');
  if (report.drift.length === 0) out.push('None.');
  for (const d of report.drift) out.push(`- **${d.severity}** \`${d.field}\`: expected \`${d.expected}\`, observed \`${d.observed}\`${d.note ? ` — ${d.note}` : ''}`);
  out.push('');
  out.push('## Caveats');
  out.push('');
  for (const caveat of report.caveats) out.push(`- ${caveat}`);
  out.push('');
  return out.join('\n');
}
