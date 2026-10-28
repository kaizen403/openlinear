import type { AgentEvent, StartInput } from '@openlinear/execution-core';
import type { TrialPhase } from '../features/types';
import type { NativeFormat } from '../runners/native/commands';
import type { SampleTaskSource } from '../tasks/samples';
import { type RecordedTrajectory, RecordedTrajectorySchema, TRAJECTORY_SCHEMA_VERSION } from '../trajectory/types';
import { stableUnit } from '../util/random';
import { type BehaviourKind, mainFile, reportedCost, synthesizeRecording } from './recordings';

/**
 * The FAKE "model" behind the W21 ablation smoke. Its success depends on what
 * actually reached it, so the pipeline is tested end to end — not on which
 * arm it is in:
 *
 * - repository context: the prompt's "## Repository context" section cites
 *   the file the fix belongs in (as the sidecar's retrieval chose it);
 * - project knowledge: the prompt's "## Project knowledge" section carries
 *   the rule relevant to the task (as the sidecar rendered it);
 * - reviewer: a failed run plants a wrong fix; the review session finds it
 *   in the diff the sidecar's prompt shows (with some recall), quoting the
 *   exact line so the sidecar's anchoring verifies it; the follow-up repairs
 *   it only if the finding is in its prompt.
 *
 * Outcomes use common random numbers (keyed by task/repeat/attempt, not by
 * configuration), so both arms of a slot face the same draw. The lifts are
 * programmed here: FAKE results prove the plumbing, never a benefit.
 */

export interface AblationFakeModel {
  /** Success probability with nothing extra in the prompt. */
  base: number;
  /** Added when the repository context section cites the file the fix belongs in. */
  contextLift: number;
  /** Added when the project knowledge section carries the task's rule. */
  knowledgeLift: number;
  /** Share of failed runs that leave a wrong fix (a planted bug) rather than nothing. */
  wrongFixShare: number;
  /** The reviewer finds a planted bug with this probability. */
  reviewerRecall: number;
  /** The reviewer reports a major issue on a correct fix with this probability (the follow-up then changes nothing). */
  reviewerFalsePositive: number;
  /** The reviewer answers without a json block with this probability (the review fails). */
  reviewerMalformed: number;
  /** The follow-up repairs a planted bug it was told about with this probability. */
  repair: number;
}

export const DEFAULT_ABLATION_FAKE: AblationFakeModel = {
  base: 0.45,
  contextLift: 0.3,
  knowledgeLift: 0.3,
  wrongFixShare: 0.75,
  reviewerRecall: 0.8,
  reviewerFalsePositive: 0.2,
  reviewerMalformed: 0.05,
  repair: 0.85,
};

/** The rule (a knowledge entry title in fixtures/knowledge/sample-holdout.json) that helps each sample task. None for the sealed task. */
export const KNOWLEDGE_HINTS: Readonly<Record<string, string>> = {
  'sum-range-inclusive': 'Ranges are inclusive and order-free',
  'slugify-collapse': 'Slugs collapse separators',
  'parse-duration-compound': 'Parsers validate the whole input first',
  'lru-refresh-on-get': 'A cache read is a use',
};

export interface TrialRunId {
  configurationId: string;
  taskId: string;
  repeat: number;
  attempt: number;
  phase: TrialPhase;
}

/** `<config>--<task>--r<repeat>--a<attempt>[--review|--follow-up]` (the harness's trial id plus the session). */
export function parseTrialRunId(runId: string): TrialRunId {
  const [configurationId = '', taskId = '', r = 'r1', a = 'a1', phase] = runId.split('--');
  return { configurationId, taskId, repeat: Number(r.slice(1)), attempt: Number(a.slice(1)), phase: phase === 'review' || phase === 'follow-up' ? phase : 'run' };
}

/** The part of a prompt from `heading` to the next `## ` heading (or the end). */
function section(prompt: string, heading: string): string | null {
  const start = prompt.indexOf(`${heading}`);
  if (start === -1) return null;
  const rest = prompt.slice(start + heading.length);
  const next = rest.search(/\n## /);
  return next === -1 ? rest : rest.slice(0, next);
}

export interface PromptSignals {
  contextCitesFile: boolean;
  knowledgeRule: boolean;
}

export function promptSignals(prompt: string, task: SampleTaskSource): PromptSignals {
  const context = section(prompt, '## Repository context');
  const knowledge = section(prompt, '## Project knowledge');
  const rule = KNOWLEDGE_HINTS[task.id];
  return {
    // The sidecar quotes paths as JSON strings in the section.
    contextCitesFile: context?.includes(JSON.stringify(mainFile(task))) === true,
    knowledgeRule: knowledge !== null && rule !== undefined && knowledge.includes(`### ${rule} (`),
  };
}

export function runBehaviour(model: AblationFakeModel, id: Pick<TrialRunId, 'taskId' | 'repeat' | 'attempt'>, signals: PromptSignals): BehaviourKind {
  const p = Math.min(0.98, model.base + (signals.contextCitesFile ? model.contextLift : 0) + (signals.knowledgeRule ? model.knowledgeLift : 0));
  if (stableUnit('ablation', id.taskId, id.repeat, id.attempt, 'run') < p) return 'fix';
  return stableUnit('ablation', id.taskId, id.repeat, id.attempt, 'failure') < model.wrongFixShare ? 'wrong-fix' : 'noop';
}

/** Lines added to `file` by a unified diff, with their line numbers in the new file. */
export function addedLines(diff: string, file: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let current: string | null = null;
  let next = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      current = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('diff --git')) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (current !== file || next === 0) continue;
    if (raw.startsWith('+')) {
      out.push({ line: next, text: raw.slice(1) });
      next += 1;
    } else if (raw.startsWith(' ')) {
      next += 1;
    }
  }
  return out;
}

const plantedTitle = (task: SampleTaskSource) => `Incomplete fix: ${task.title}`;

/** The reviewer's answer for a review prompt (the sidecar's `buildReviewPrompt` output). */
export function reviewAnswer(model: AblationFakeModel, task: SampleTaskSource, id: Pick<TrialRunId, 'taskId' | 'repeat' | 'attempt'>, prompt: string): { text: string; planted: boolean; found: boolean } {
  const fence = /(`{3,})diff\n([\s\S]*?)\n\1/.exec(prompt);
  const file = mainFile(task);
  const added = addedLines(fence?.[2] ?? '', file);
  // The planted bug is the wrong fix: it adds wrong-fix lines and none of the lines only the correct fix has.
  const lines = (text: string | undefined) => new Set((text ?? '').split('\n').map((line) => line.trim()).filter(Boolean));
  const original = lines(task.files[file]);
  const wrong = lines(task.wrongFix[file]);
  const wrongAdded = new Set([...wrong].filter((line) => !original.has(line)));
  const fixOnly = new Set([...lines(task.fixed[file])].filter((line) => !wrong.has(line) && !original.has(line)));
  const planted = added.some((entry) => wrongAdded.has(entry.text.trim())) && !added.some((entry) => fixOnly.has(entry.text.trim()));
  const bug = planted ? added.find((entry) => wrongAdded.has(entry.text.trim())) : undefined;
  const draw = (label: string) => stableUnit('ablation', id.taskId, id.repeat, id.attempt, label);
  if (draw('review-malformed') < model.reviewerMalformed) return { text: 'I read the change and the tests; nothing stands out.', planted: bug !== undefined, found: false };
  const findings: Array<Record<string, unknown>> = [];
  const found = bug !== undefined && draw('review-recall') < model.reviewerRecall;
  if (bug && found) {
    findings.push({ severity: 'major', file, startLine: bug.line, endLine: bug.line, quote: bug.text, title: plantedTitle(task), body: 'This line still misses a case the task asks for; the hidden checks will fail. Handle it and rerun the test.' });
  } else if (!bug && added[0] && draw('review-false-positive') < model.reviewerFalsePositive) {
    findings.push({ severity: 'major', file, startLine: added[0].line, endLine: added[0].line, quote: added[0].text, title: 'Possible regression in the changed function', body: 'Double-check this line against the callers.' });
  }
  if (added[0] && draw('review-nit') < 0.5) {
    findings.push({ severity: 'nit', file, startLine: added[0].line, endLine: added[0].line, quote: added[0].text, title: 'Consider a clearer name', body: '' });
  }
  const summary = findings.length > 0 ? `${findings.length} finding(s) on ${file}.` : 'The change does what the task asks.';
  return { text: `I read the diff and ${file}.\n\n\`\`\`json\n${JSON.stringify({ summary, findings }, null, 2)}\n\`\`\`\n`, planted: bug !== undefined, found };
}

/** About four characters per token: the fake charges a prompt's length as fresh input. */
export const promptTokens = (prompt: string) => Math.ceil(prompt.length / 4);

/** A review session as an adapter event stream: read, answer, usage (its own message id), idle. */
export function reviewRecording(input: { task: SampleTaskSource; model: string; runner: string; seedLabel: string; text: string; promptTokens: number }): RecordedTrajectory {
  const jitter = stableUnit(input.seedLabel, 'jitter');
  const tokens = { input: Math.round(12_000 * (0.8 + jitter * 0.4)) + input.promptTokens, output: Math.round(900 * (0.8 + jitter * 0.4)), cacheRead: 30_000, cacheWrite: 4_000, reasoning: 400 };
  const file = mainFile(input.task);
  const events: AgentEvent[] = [
    { t: 'session.started', externalId: `ses-${input.task.id}-review`, model: { provider: 'fake', id: input.model } },
    { t: 'turn.started', turn: 1 },
    { t: 'message.delta', text: `Reading ${file} at the reviewed commit. ` },
    { t: 'tool.started', callId: 'call-review-read', name: 'read', input: { filePath: file } },
    { t: 'tool.finished', callId: 'call-review-read', name: 'read', ok: true, summary: '(file source)' },
    { t: 'message.delta', text: input.text },
    { t: 'usage', usage: tokens, cost: { usd: reportedCost(tokens), basis: 'opencode message cost (synthetic)' }, messageId: `msg-${input.task.id}-review` },
    { t: 'turn.finished', turn: 1, reason: 'idle' },
  ];
  return RecordedTrajectorySchema.parse({
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    id: `${input.runner}-${input.task.id}-review-${input.seedLabel}`,
    taskId: input.task.id,
    runner: input.runner,
    source: 'synthetic',
    agentEvents: events.map((event, index) => ({ atMs: 120 * (index + 1), event })),
    native: null,
    effects: [],
    behavior: { startError: null, hangAfterEvent: null },
    note: 'synthetic review',
  });
}

/** What a fake session received (the tests assert on these). */
export interface AblationFakeCall {
  runId: string;
  phase: TrialPhase;
  prompt: string;
  systemContract: string | null;
  permissions: string | null;
  worktree: string;
  behaviour: string;
}

/**
 * The fake runner's recording chooser for every session of an ablation
 * trial: plug `pick` into a `ReplayAgentRunner` (adapter) or `pickNative`
 * into a FAKE `NativeCliRunner` (prompt sections only).
 */
export class AblationFake {
  readonly calls: AblationFakeCall[] = [];

  constructor(
    private readonly options: { sources: ReadonlyMap<string, SampleTaskSource>; model: string; runner: string; fake?: AblationFakeModel; timeScale?: number },
  ) {}

  private source(taskId: string): SampleTaskSource {
    const source = this.options.sources.get(taskId);
    if (!source) throw new Error(`no sample source for ${taskId}`);
    return source;
  }

  private decide(runId: string, prompt: string): { id: TrialRunId; task: SampleTaskSource; kind: BehaviourKind | 'review'; review?: string } {
    const model = this.options.fake ?? DEFAULT_ABLATION_FAKE;
    const id = parseTrialRunId(runId);
    const task = this.source(id.taskId);
    if (id.phase === 'review') return { id, task, kind: 'review', review: reviewAnswer(model, task, id, prompt).text };
    if (id.phase === 'follow-up') {
      const told = prompt.includes(`Major: ${plantedTitle(task)}`) || prompt.includes(`Blocker: ${plantedTitle(task)}`);
      const repairs = told && stableUnit('ablation', id.taskId, id.repeat, id.attempt, 'repair') < model.repair;
      return { id, task, kind: repairs ? 'fix' : 'noop' };
    }
    return { id, task, kind: runBehaviour(model, id, promptSignals(prompt, task)) };
  }

  pick = (start: StartInput): RecordedTrajectory => {
    const { id, task, kind, review } = this.decide(start.runId, start.prompt);
    this.calls.push({ runId: start.runId, phase: id.phase, prompt: start.prompt, systemContract: start.systemContract, permissions: start.permissions.default, worktree: start.worktreePath, behaviour: kind });
    if (kind === 'review') return reviewRecording({ task, model: this.options.model, runner: this.options.runner, seedLabel: start.runId, text: review ?? '', promptTokens: promptTokens(start.prompt) });
    return synthesizeRecording({ task, kind, runner: this.options.runner, model: this.options.model, format: null, seedLabel: start.runId, extraInputTokens: promptTokens(start.prompt), ...(id.phase === 'run' ? {} : { phase: id.phase }) });
  };

  pickNative = (ctx: { trialId: string; prompt: string; worktree: string; systemContract: string }, format: NativeFormat): RecordedTrajectory => {
    const { id, task, kind } = this.decide(ctx.trialId, ctx.prompt);
    if (kind === 'review') throw new Error('native CLIs run no reviewer session');
    this.calls.push({ runId: ctx.trialId, phase: id.phase, prompt: ctx.prompt, systemContract: null, permissions: null, worktree: ctx.worktree, behaviour: kind });
    return synthesizeRecording({ task, kind, runner: this.options.runner, model: this.options.model, format, seedLabel: ctx.trialId, timeScale: this.options.timeScale ?? 0.04, extraInputTokens: promptTokens(ctx.prompt) });
  };
}
