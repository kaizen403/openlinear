import { join } from 'node:path';
import type { AgentEvent } from '@openlinear/execution-core';
import type { Termination } from '../grading/outcome';
import type { EvalManifest } from '../manifest/schema';
import type { FeatureSupport, HarnessRunner, RunnerResult, TrialContext } from '../runners/types';
import type { LoadedTask } from '../tasks/types';
import type { TimedEvent } from '../trajectory/types';
import { finalizeTrialUsage, mergeRawUsage, type RawUsage, UNKNOWN_USAGE } from '../usage/cost';
import { checkKnowledgeFixture, DEFAULT_KNOWLEDGE_DIR, type LoadedKnowledgeFixture, loadKnowledgeFixture, selectPromptKnowledge } from './knowledge';
import { ACTIONABLE_SEVERITIES, readFileAtCommit, reviewFollowUpPrompt, snapshotForReview } from './reviewer';
import { loadSidecarFeatures, type SidecarFeatures } from './sidecar';
import { featureProblems, supports } from './support';
import { enabledFeatures, type FeatureReceipt, type PhaseReceipt, type TrialPhase } from './types';

/**
 * W21 ablation arms, applied per trial (harness.ts calls `runWithFeatures`
 * for every configuration that enables a feature):
 *
 *   prompt sections (before start)   knowledge, then repository context — the
 *                                    order of the run engine's `promptFor`
 *   run                              the agent session, as for the baseline
 *   reviewer (after a completed run) the agent's work committed into a
 *                                    disposable clone; a fresh session with the
 *                                    reviewer contract and a deny policy;
 *                                    findings parsed and anchored by the
 *                                    sidecar's contract
 *   follow-up (blocker/major found)  one more session in the trial worktree with
 *                                    the findings as review comments
 *
 * Grading sees the final worktree, as for every trial. Usage of every session
 * is summed into the trial (the PRD wants extra agents justified net of
 * cost), the per-task USD cap is shared by the sessions, and the merged
 * event stream replays to the same outcome (`pnpm eval:cli replay`).
 */

export interface FeatureEnvironment {
  sidecar: SidecarFeatures;
  /** Fixture name → loaded fixture (checksum and provenance checked). */
  knowledge: ReadonlyMap<string, LoadedKnowledgeFixture>;
  /** Memory-only context engine shared by the evaluation's trials. */
  contextEngine: unknown;
  /** Not blocking (e.g. in-sample knowledge entries); surfaced in the report. */
  notes: string[];
}

export class FeatureConfigurationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`features cannot be applied:\n${problems.map((p) => `- ${p}`).join('\n')}`);
    this.name = 'FeatureConfigurationError';
  }
}

export interface PrepareFeaturesInput {
  manifest: EvalManifest;
  /** The whole holdout (sealed tasks outside the manifest count for the knowledge guard). */
  tasks: readonly LoadedTask[];
  sidecarSrc?: string;
  knowledgeDir?: string;
  canaries?: readonly string[];
}

/** Loads the knowledge fixtures the manifest pins and checks them. Throws with every problem at once. */
export async function loadPinnedKnowledge(input: PrepareFeaturesInput): Promise<{ knowledge: Map<string, LoadedKnowledgeFixture>; problems: string[]; notes: string[] }> {
  const knowledge = new Map<string, LoadedKnowledgeFixture>();
  const problems: string[] = [];
  const notes: string[] = [];
  for (const config of input.manifest.configurations) {
    const ref = config.features?.knowledge;
    if (!ref || knowledge.has(ref.fixture)) continue;
    let loaded: LoadedKnowledgeFixture;
    try {
      loaded = await loadKnowledgeFixture(input.knowledgeDir ?? DEFAULT_KNOWLEDGE_DIR, ref.fixture);
    } catch (error) {
      problems.push(`knowledge fixture ${ref.fixture}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      continue;
    }
    const check = checkKnowledgeFixture({ loaded, expectedChecksum: ref.checksum, manifest: input.manifest, tasks: input.tasks, canaries: input.canaries });
    problems.push(...check.problems);
    notes.push(...check.notes);
    knowledge.set(ref.fixture, loaded);
  }
  return { knowledge, problems, notes };
}

export async function prepareFeatureEnvironment(input: PrepareFeaturesInput): Promise<FeatureEnvironment> {
  const problems = featureProblems(input.manifest);
  const pinned = await loadPinnedKnowledge(input);
  problems.push(...pinned.problems);
  if (problems.length > 0) throw new FeatureConfigurationError(problems);
  const sidecar = await loadSidecarFeatures(input.sidecarSrc);
  return { sidecar, knowledge: pinned.knowledge, contextEngine: sidecar.createContextEngine(), notes: pinned.notes };
}

/**
 * Called by `runEvaluation` before anything runs: every configuration that
 * enables a feature must get it applied — a feature environment, a runner
 * that supports it, the pinned knowledge fixture. `recorded` (offline
 * replay) means the recorded trajectories already contain every session.
 */
export function assertFeaturesApplicable(input: {
  manifest: EvalManifest;
  runners: ReadonlyMap<string, HarnessRunner>;
  features: FeatureEnvironment | 'recorded' | undefined;
  tasks: readonly LoadedTask[];
  canaries: readonly string[];
}): void {
  const { manifest, features } = input;
  const problems = featureProblems(manifest);
  for (const config of manifest.configurations) {
    const enabled = enabledFeatures(config);
    if (enabled.length === 0 || features === 'recorded') continue;
    if (!features) {
      problems.push(`${config.id} enables ${enabled.join(', ')} but no feature environment was given: it would run as the baseline`);
      continue;
    }
    const support: FeatureSupport | undefined = input.runners.get(config.id)?.featureSupport;
    for (const feature of enabled) {
      if (!supports(support, feature)) problems.push(`${config.id}: its runner (${input.runners.get(config.id)?.kind ?? 'none'}) cannot apply ${feature}`);
    }
    const ref = config.features?.knowledge;
    if (ref) {
      const loaded = features.knowledge.get(ref.fixture);
      if (!loaded) problems.push(`${config.id}: knowledge fixture ${ref.fixture} was not loaded`);
      else problems.push(...checkKnowledgeFixture({ loaded, expectedChecksum: ref.checksum, manifest, tasks: input.tasks, canaries: input.canaries }).problems);
    }
  }
  if (problems.length > 0) throw new FeatureConfigurationError([...new Set(problems)]);
}

// ---------------------------------------------------------------------------
// One trial
// ---------------------------------------------------------------------------

/** Reasons the sidecar gives when there is genuinely nothing to add; anything else is a platform failure. */
const BENIGN_NO_CONTEXT = /no searchable words|shares words|nothing related|did not fit/;
const CONTEXT_TIMEOUT_MS = 120_000;

interface Phase {
  phase: TrialPhase;
  result: RunnerResult;
  /** Offset from the start of the run session. */
  offsetMs: number;
}

function neutralized(phase: TrialPhase, event: AgentEvent): AgentEvent {
  // A finished, cancelled or failed session that is not the trial's last word becomes a note,
  // so consumers (and replays) see exactly one terminal event: the trial's.
  if (event.t === 'turn.finished') return { t: 'diagnostic', code: `eval.${phase}.finished`, message: `${phase} session finished (${event.reason})` };
  if (event.t === 'cancel.receipt') return { t: 'diagnostic', code: `eval.${phase}.cancelled`, message: `${phase} session stopped (${event.via}, ${event.confirmedBy})` };
  if (event.t === 'error') return { t: 'diagnostic', code: `eval.${phase}.error`, message: `${event.code}: ${event.message}` };
  return event;
}

const TERMINAL: ReadonlySet<AgentEvent['t']> = new Set(['turn.finished', 'cancel.receipt']);

/** One event stream for the trial; only `terminal`'s closing events stay terminal, at the end. */
export function mergePhaseEvents(phases: readonly Phase[], terminal: TrialPhase): TimedEvent[] {
  const out: TimedEvent[] = [];
  let closing: TimedEvent[] = [];
  for (const { phase, result, offsetMs } of phases) {
    if (phase !== 'run') out.push({ atMs: offsetMs, event: { t: 'diagnostic', code: 'eval.phase', message: `${phase} session started` } });
    const events = result.events.map((timed) => ({ atMs: timed.atMs + offsetMs, event: timed.event }));
    if (phase === terminal) {
      let cut = events.length;
      while (cut > 0 && TERMINAL.has(events[cut - 1]?.event.t ?? 'heartbeat')) cut -= 1;
      out.push(...events.slice(0, cut));
      closing = events.slice(cut);
    } else {
      out.push(...events.map((timed) => ({ atMs: timed.atMs, event: neutralized(phase, timed.event) })));
    }
  }
  const end = out.reduce((max, timed) => Math.max(max, timed.atMs), 0);
  out.push(...closing.map((timed) => ({ atMs: Math.max(timed.atMs, end), event: timed.event })));
  return out;
}

/** A session that never started spent nothing; everything else counts (unknown stays unknown). */
function spentUsage(result: RunnerResult): RawUsage | null {
  return result.startErrorCode && result.events.length === 0 ? null : result.usage;
}

/** The reviewer's answer: its message text, collected by the sidecar's own rule (capped). */
function answerText(result: RunnerResult, sidecar: SidecarFeatures): string {
  let text = '';
  for (const { event } of result.events) {
    if (event.t === 'message.delta') text = sidecar.appendReviewAnswer(text, event.text);
  }
  return text;
}

export async function runWithFeatures(input: { runner: HarnessRunner; ctx: TrialContext; env: FeatureEnvironment }): Promise<RunnerResult> {
  const { runner, ctx, env } = input;
  const { configuration: config, manifest } = ctx;
  const features = config.features ?? {};
  const receipt: FeatureReceipt = { enabled: enabledFeatures(config), phases: [] };
  const notes: string[] = [];
  const sections: string[] = [];
  let platformFailure: string | null = null;

  // 1. Prompt sections, in the run engine's order: knowledge, then repository context.
  if (features.knowledge) {
    const loaded = env.knowledge.get(features.knowledge.fixture);
    if (!loaded) throw new Error(`knowledge fixture ${features.knowledge.fixture} was not loaded`);
    const entries = selectPromptKnowledge(loaded.fixture.entries);
    const section = env.sidecar.projectKnowledgeSection(entries.map(({ kind, title, body }) => ({ kind, title, body })));
    if (section) sections.push(section);
    receipt.knowledge = { fixture: loaded.name, checksum: loaded.checksum, entries: entries.map(({ kind, title }) => ({ kind, title })), chars: section?.length ?? 0 };
    notes.push(`Project knowledge: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} given to the agent (${loaded.name}): ${entries.map((entry) => entry.title).join(', ')}`);
  }
  if (features.repositoryContext) {
    const context = await env.sidecar.repositoryContextFor(
      {
        worktreePath: ctx.worktree,
        commitSha: ctx.baseSha,
        repositoryKey: `eval:${ctx.task.spec.id}`,
        task: { title: ctx.task.spec.title, description: ctx.task.instruction, labels: [] },
        maxChars: features.repositoryContext.maxChars,
        maxFiles: features.repositoryContext.maxFiles,
        // Wait for the index (a cold build of a large repository can pass the sidecar's 20 s): "still indexing" would run the baseline.
        timeoutMs: CONTEXT_TIMEOUT_MS,
        signal: ctx.signal,
      },
      env.contextEngine,
    );
    if (context.section) sections.push(context.section);
    receipt.repositoryContext = {
      section: context.section !== null,
      chars: context.section?.length ?? 0,
      citations: context.citations.map((citation) => citation.path),
      commit: context.receipt.sha,
      indexedFiles: context.receipt.indexedFiles,
      ms: context.receipt.ms,
      reason: context.reason,
    };
    notes.push(context.section ? `Repository context: ${context.citations.length} file(s) at ${context.receipt.sha?.slice(0, 12) ?? '?'}: ${context.citations.map((c) => c.path).join(', ')}` : `Repository context: none (${context.reason ?? 'no reason'})`);
    // An index that could not be built is the platform failing, not the treatment: never let it pass as the baseline.
    if (!context.section && !BENIGN_NO_CONTEXT.test(context.reason ?? '')) platformFailure = `repository context unavailable: ${context.reason ?? 'unknown'}`;
  }
  const prompt = sections.length > 0 ? `${ctx.prompt.trimEnd()}\n\n${sections.join('\n\n')}` : ctx.prompt;
  if (platformFailure) {
    // Nothing is started. Recorded as a start failure so an offline replay reproduces the infra outcome.
    return {
      termination: 'infra',
      terminationDetail: platformFailure,
      events: [],
      nativeLines: [],
      usage: UNKNOWN_USAGE,
      agentMs: 0,
      firstActionMs: null,
      observedModel: null,
      observedRunnerVersion: null,
      invocation: null,
      logs: notes,
      startErrorCode: 'EVAL_FEATURE_UNAVAILABLE',
      prompt,
      features: receipt,
    };
  }

  const phases: Phase[] = [];
  const runStart = Date.now();
  const record = (phase: TrialPhase, result: RunnerResult, startedAt: number): RunnerResult => {
    phases.push({ phase, result, offsetMs: startedAt - runStart });
    const usage = finalizeTrialUsage(manifest, config, result.usage);
    receipt.phases.push({ phase, termination: result.termination, agentMs: result.agentMs, costUsd: usage.costUsd, costBasis: usage.costBasis, tokens: usage.tokens } satisfies PhaseReceipt);
    return result;
  };
  const finish = (terminal: TrialPhase, termination: Termination, detail: string): RunnerResult => {
    const last = phases.find((p) => p.phase === terminal)?.result ?? phases[0]?.result;
    const main = phases[0]?.result;
    if (!main || !last) throw new Error('no session ran');
    const spent = phases.map((p) => spentUsage(p.result)).filter((usage): usage is RawUsage => usage !== null);
    return {
      termination,
      terminationDetail: detail,
      events: phases.length === 1 ? main.events : mergePhaseEvents(phases, terminal),
      nativeLines: main.nativeLines,
      usage: phases.length === 1 ? main.usage : mergeRawUsage(spent),
      agentMs: Date.now() - runStart,
      firstActionMs: main.firstActionMs,
      observedModel: main.observedModel,
      observedRunnerVersion: main.observedRunnerVersion,
      invocation: main.invocation,
      logs: [...notes, ...phases.flatMap((p) => (p.phase === 'run' ? p.result.logs : [`--- ${p.phase} session (${p.result.termination}: ${p.result.terminationDetail}) ---`, ...p.result.logs]))],
      ...(last.startErrorCode ? { startErrorCode: last.startErrorCode } : {}),
      ...(last.exitCode !== undefined ? { exitCode: last.exitCode } : {}),
      prompt,
      features: receipt,
    };
  };

  // 2. The run (identical to the baseline's, apart from the prompt).
  const main = record('run', await runner.run({ ...ctx, prompt, phase: 'run' }), runStart);
  const reviewer = features.reviewer;
  if (!reviewer) return finish('run', main.termination, main.terminationDetail);

  const skip = (reason: string): RunnerResult => {
    receipt.reviewer = { status: 'skipped', reason, commit: null, findings: [], actionable: 0, followUp: 'skipped' };
    notes.push(`Reviewer: skipped (${reason})`);
    return finish('run', main.termination, main.terminationDetail);
  };
  if (main.termination !== 'completed') return skip(`the run ended ${main.termination}`);

  // The per-task USD cap is shared by the sessions; unknown spend leaves the full cap (and is said so).
  const cap = manifest.budgets.maxUsdPerTask;
  const remaining = (): number | null => {
    if (cap === null) return null;
    const known = receipt.phases.map((p) => p.costUsd);
    if (known.some((usd) => usd === null)) {
      notes.push('a previous session’s cost is unknown: the next session gets the full per-task cap');
      return cap;
    }
    return cap - known.reduce<number>((sum, usd) => sum + (usd ?? 0), 0);
  };

  // 3. Reviewer pass over a disposable checkout of the agent's work.
  const reviewDir = join(ctx.scratchDir, 'review');
  const snapshot = await snapshotForReview({ worktree: ctx.worktree, baseSha: ctx.baseSha, dir: reviewDir, maxDiffChars: env.sidecar.maxReviewDiffChars });
  if (!snapshot) return skip('the run changed nothing');
  const reviewBudget = remaining();
  if (reviewBudget !== null && reviewBudget <= 0) return skip('the per-task USD cap is spent');
  const taskText = { title: ctx.task.spec.title, description: ctx.task.instruction };
  const reviewStart = Date.now();
  const review = record(
    'review',
    await runner.run({
      ...ctx,
      trialId: `${ctx.trialId}--review`,
      worktree: snapshot.checkout,
      scratchDir: join(reviewDir, 'session'),
      prompt: env.sidecar.buildReviewPrompt({ task: { ...taskText, labels: [] }, commit: snapshot.commit, baseCommit: ctx.baseSha, changedFiles: snapshot.changedFiles, diff: snapshot.diff, diffTruncated: snapshot.diffTruncated }),
      systemContract: env.sidecar.reviewerSystemContract,
      phase: 'review',
      budgetUsd: reviewBudget,
    }),
    reviewStart,
  );
  if (review.termination === 'infra') {
    receipt.reviewer = { status: 'failed', reason: `reviewer session: ${review.terminationDetail}`, commit: snapshot.commit, findings: [], actionable: 0, followUp: 'skipped' };
    // The treatment did not get its reviewer because the platform failed: a predeclared infra rerun, not a baseline result.
    return finish('review', 'infra', `reviewer session: ${review.terminationDetail}`);
  }
  const failed = (reason: string): RunnerResult => {
    receipt.reviewer = { status: 'failed', reason, commit: snapshot.commit, findings: [], actionable: 0, followUp: 'skipped' };
    notes.push(`Reviewer: failed (${reason})`);
    return finish('run', main.termination, main.terminationDetail);
  };
  if (review.termination !== 'completed') return failed(`the reviewer session ended ${review.termination}: ${review.terminationDetail}`);
  const parsed = env.sidecar.parseReviewOutput(answerText(review, env.sidecar));
  if (!parsed.ok) return failed(parsed.error);
  const usable = parsed.output.findings.filter((finding) => env.sidecar.safeRepoPath(finding.file) !== null);
  const findings = await env.sidecar.anchorFindings(snapshot.commit, usable, new Set(snapshot.changedFiles), (path) => readFileAtCommit(snapshot.checkout, snapshot.commit, path));
  const actionable = findings.filter((finding) => ACTIONABLE_SEVERITIES.has(finding.severity)).slice(0, reviewer.maxFindings);
  receipt.reviewer = {
    status: 'completed',
    reason: null,
    commit: snapshot.commit,
    findings: findings.map(({ severity, file, startLine, endLine, title, evidence, inDiff }) => ({ severity, file, startLine, endLine, title, evidence, inDiff })),
    actionable: actionable.length,
    followUp: !reviewer.followUp ? 'disabled' : actionable.length === 0 ? 'not-needed' : 'skipped',
  };
  notes.push(`Reviewer: ${findings.length} finding(s) at ${snapshot.commit.slice(0, 12)}, ${actionable.length} blocker/major`);
  if (!reviewer.followUp || actionable.length === 0) return finish('run', main.termination, main.terminationDetail);

  // 4. One follow-up turn in the trial worktree with the blocker/major findings.
  const followBudget = remaining();
  if (followBudget !== null && followBudget <= 0) {
    notes.push('Follow-up: skipped (the per-task USD cap is spent)');
    return finish('run', main.termination, main.terminationDetail);
  }
  receipt.reviewer.followUp = 'ran';
  const followStart = Date.now();
  const follow = record(
    'follow-up',
    await runner.run({
      ...ctx,
      trialId: `${ctx.trialId}--follow-up`,
      scratchDir: join(ctx.scratchDir, 'follow-up'),
      prompt: reviewFollowUpPrompt({ task: taskText, findings: actionable, baseSha: ctx.baseSha, diff: snapshot.diff }),
      phase: 'follow-up',
      budgetUsd: followBudget,
    }),
    followStart,
  );
  return finish('follow-up', follow.termination, `follow-up: ${follow.terminationDetail}`);
}
