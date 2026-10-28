import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, AgentSession } from '@openlinear/execution-core';
import { sidecarAppDataDir } from '../../config/app-data';
import { HttpError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { execGit } from '../../services/git-credentials';
import type { RunRuntime } from '../runtime';
import type { RuntimeEndpoint } from '../types';
import { createPristineCheckout, pristineCheckoutPath, removePristineCheckout, type PristineCheckout } from '../verification/checkout';
import { readFileAtCommit } from '../verification/manifest';
import {
  anchorFindings,
  appendReviewAnswer,
  buildReviewPrompt,
  isStaleAt,
  MAX_REVIEW_DIFF_CHARS,
  parseReviewOutput,
  REVIEWER_SYSTEM_CONTRACT,
  safeRepoPath,
  type ReviewFinding,
} from './contract';
import { ReviewStore, type ReviewRecord } from './store';

/**
 * W19a / FE-12: the independent reviewer.
 *
 * On the user's request, a fresh session of the task's runner reviews the
 * newest finished run's commit:
 *
 * - **scoped snapshot**: a disposable clone of that commit
 *   (`<repos>/verify/review-<id>`, the W11a pristine checkout — shares
 *   nothing writable with the run's worktree), removed afterwards;
 * - **nothing it writes survives**: the session starts with
 *   `permissions.default: 'deny'` (Claude Code honours it; OpenCode and
 *   Codex runs are policy-only and could write — into the disposable clone,
 *   inside the OS sandbox) and any permission request is denied; the clone
 *   is thrown away;
 * - **bounded**: one review per task at a time, a wall-clock limit, the
 *   run's cost budget (when it has one), the diff capped in the prompt;
 * - **checkable findings**: each is anchored to the file at the reviewed
 *   commit by its quote (`verified` / `relocated` / `unverified`), and is
 *   marked stale when a later commit no longer contains it.
 *
 * Reviews are advisory local artifacts (ReviewStore); acting on a finding
 * (a follow-up comment, an issue) is the user's explicit choice in the UI.
 */

export interface ReviewSubject {
  runId: string;
  userId: string;
  runner: string;
  model: string | null;
  worktreePath: string;
  baseCommit: string | null;
  task: { title: string; description: string | null; labels: string[] };
  maxUsd: number | null;
}

export type ReviewSubjectResult = { ok: true; subject: ReviewSubject } | { ok: false; status: number; code: string; message: string };

export interface ReviewSubjectSource {
  reviewSubject(taskId: string): ReviewSubjectResult;
}

export interface ReviewEventSink {
  publish(taskId: string, ownerUserId: string, event: string, payload: Record<string, unknown>): void;
}

export interface ReviewerDeps {
  source: ReviewSubjectSource;
  runtimes: ReadonlyMap<string, RunRuntime>;
  reposRoot: () => string;
  store?: ReviewStore;
  events?: ReviewEventSink;
  now?: () => number;
  bootId?: string;
  /** Wall clock per review (default 10 min). */
  timeoutMs?: number;
  /** After a stop or the deadline, how long a session's stream may take to end (default 5 s). */
  abortGraceMs?: number;
}

export interface ReviewView extends Omit<ReviewRecord, 'findings' | 'bootId'> {
  findings: Array<ReviewFinding & { stale: boolean | null }>;
  /** The task's checkout is at another commit now (findings were re-checked against it). */
  headCommit: string | null;
}

/** One running review: how to stop it, and why it stopped (first reason wins). */
interface Execution {
  reviewId: string;
  controller: AbortController;
  stop: 'cancelled' | 'timeout' | 'budget' | null;
}

const SHA = /^[0-9a-f]{40,64}$/;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const ABORT_GRACE_MS = 5_000;
const MAX_FILE_BYTES = 1024 * 1024;

export function defaultReviewStoreRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(sidecarAppDataDir(env), 'reviews');
}

async function headOf(worktree: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['-C', worktree, 'rev-parse', 'HEAD']);
    const sha = stdout.trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function parentOf(worktree: string, commit: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(['-C', worktree, 'rev-parse', `${commit}^`]);
    const sha = stdout.trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * git output up to `maxBuffer`: what was read when the output is larger
 * (the prompt only ever uses a bounded prefix), never the error with the
 * whole output attached.
 */
async function boundedGit(args: string[], maxBuffer: number): Promise<{ stdout: string; overflow: boolean }> {
  try {
    const { stdout } = await execGit(args, { maxBuffer });
    return { stdout, overflow: false };
  } catch (error) {
    const partial = error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : null;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && partial !== null) return { stdout: partial, overflow: true };
    throw new Error(`git failed: ${error instanceof Error ? (error.message.split('\n')[0] ?? '').slice(0, 300) : 'unknown error'}`);
  }
}

async function changedFilesOf(checkout: string, base: string, commit: string): Promise<string[]> {
  const { stdout, overflow } = await boundedGit(['-C', checkout, 'diff', '--name-only', '-z', '--no-renames', base, commit, '--'], 8 * 1024 * 1024);
  const names = stdout.split('\0').filter(Boolean);
  // A cut-off listing ends in a partial name.
  return overflow ? names.slice(0, -1) : names;
}

async function diffOf(checkout: string, base: string, commit: string): Promise<{ text: string; truncated: boolean }> {
  const { stdout, overflow } = await boundedGit(['-C', checkout, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=3', base, commit, '--'], MAX_REVIEW_DIFF_CHARS * 4 + 1024);
  return overflow || stdout.length > MAX_REVIEW_DIFF_CHARS
    ? { text: `${stdout.slice(0, MAX_REVIEW_DIFF_CHARS)}\n… (diff truncated)`, truncated: true }
    : { text: stdout, truncated: false };
}

export class ReviewerService {
  private readonly store: ReviewStore;
  private readonly now: () => number;
  private readonly bootId: string;
  private readonly active = new Map<string, Execution>();

  constructor(private readonly deps: ReviewerDeps) {
    this.store = deps.store ?? new ReviewStore(defaultReviewStoreRoot());
    this.now = deps.now ?? Date.now;
    this.bootId = deps.bootId ?? randomUUID();
  }

  isReviewing(taskId: string): boolean {
    return this.active.has(taskId);
  }

  /** A checkout directory (`<repos>/verify/<entry>`) a running review is using (retention must keep it). */
  isActiveCheckout(entry: string): boolean {
    for (const execution of this.active.values()) if (entry === `review-${execution.reviewId}`) return true;
    return false;
  }

  /** Starts a review of the task's newest finished run; answers with the running record. */
  async start(taskId: string, userId: string): Promise<ReviewRecord> {
    if (this.active.has(taskId)) throw new HttpError(409, 'REVIEW_RUNNING', 'A review of this task is already running');
    const resolved = this.deps.source.reviewSubject(taskId);
    if (!resolved.ok) throw new HttpError(resolved.status, resolved.code, resolved.message);
    const subject = resolved.subject;
    const runtime = this.deps.runtimes.get(subject.runner);
    if (!runtime) throw new HttpError(409, 'REVIEW_RUNNER_UNAVAILABLE', `${subject.runner} is not available on this device`);
    if (!existsSync(subject.worktreePath)) {
      throw new HttpError(409, 'REVIEW_WORKSPACE_GONE', 'The run\'s checkout is no longer on this device (cleaned up); run the task again to review it');
    }
    const commit = await headOf(subject.worktreePath);
    if (!commit) throw new HttpError(409, 'REVIEW_WORKSPACE_GONE', 'The run\'s checkout has no readable commit');
    const baseCommit = subject.baseCommit && SHA.test(subject.baseCommit) ? subject.baseCommit : await parentOf(subject.worktreePath, commit);
    if (!baseCommit || baseCommit === commit) throw new HttpError(409, 'REVIEW_NOTHING_TO_REVIEW', 'The run made no commit to review');
    // Re-check after the awaits: two clicks must not start two reviews.
    if (this.active.has(taskId)) throw new HttpError(409, 'REVIEW_RUNNING', 'A review of this task is already running');

    const record: ReviewRecord = {
      id: randomUUID(),
      taskId,
      runId: subject.runId,
      userId,
      runner: subject.runner,
      commit,
      baseCommit,
      status: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      summary: '',
      findings: [],
      dropped: 0,
      diffTruncated: false,
      usage: { usd: 0, inputTokens: 0, outputTokens: 0 },
      error: null,
      bootId: this.bootId,
    };
    const execution: Execution = { reviewId: record.id, controller: new AbortController(), stop: null };
    this.active.set(taskId, execution);
    this.save(record, subject.userId);
    void this.execute(record, subject, runtime, execution);
    return record;
  }

  /** Stops a running review (its record ends `cancelled`). */
  cancel(taskId: string, reviewId: string): boolean {
    const execution = this.active.get(taskId);
    if (!execution || execution.reviewId !== reviewId) return false;
    stopExecution(execution, 'cancelled');
    return true;
  }

  /**
   * The task's reviews, newest first. A `running` review of an earlier
   * sidecar process was interrupted; findings are re-checked against the
   * task's checkout when it has moved past the reviewed commit.
   */
  async list(taskId: string): Promise<ReviewView[]> {
    const reviews = this.store.list(taskId);
    const subject = this.deps.source.reviewSubject(taskId);
    const worktree = subject.ok && existsSync(subject.subject.worktreePath) ? subject.subject.worktreePath : null;
    const head = worktree ? await headOf(worktree) : null;
    const views: ReviewView[] = [];
    for (const review of reviews) {
      const interrupted = review.status === 'running' && review.bootId !== this.bootId && !this.active.has(taskId);
      const { bootId: _bootId, findings, ...rest } = review;
      const moved = worktree !== null && head !== null && head !== review.commit;
      const files = new Map<string, string | null>();
      const checked: ReviewView['findings'] = [];
      for (const finding of findings) {
        if (!moved || worktree === null || head === null) {
          // Same commit: not stale. No readable checkout: can't tell.
          checked.push({ ...finding, stale: worktree !== null && head !== null ? false : null });
          continue;
        }
        if (!files.has(finding.file)) files.set(finding.file, (await readFileAtCommit(worktree, head, finding.file, MAX_FILE_BYTES)).text);
        checked.push({ ...finding, stale: isStaleAt(files.get(finding.file) ?? null, finding) });
      }
      views.push({
        ...rest,
        ...(interrupted ? { status: 'failed' as const, error: 'Interrupted: the sidecar restarted while the review ran', finishedAt: rest.finishedAt } : {}),
        findings: checked,
        headCommit: moved ? head : null,
      });
    }
    return views;
  }

  private save(record: ReviewRecord, ownerUserId: string): void {
    try {
      this.store.save(record);
    } catch (error) {
      logger.warn({ err: error, taskId: record.taskId }, '[Reviewer] could not save the review');
    }
    this.deps.events?.publish(record.taskId, ownerUserId, 'review:changed', { taskId: record.taskId, reviewId: record.id, status: record.status });
  }

  private finish(record: ReviewRecord, ownerUserId: string, patch: Partial<ReviewRecord>): void {
    Object.assign(record, patch, { finishedAt: new Date(this.now()).toISOString() });
    this.save(record, ownerUserId);
  }

  /** Runs the review and records its outcome once its checkout is gone and the task is free for another review. */
  private async execute(record: ReviewRecord, subject: ReviewSubject, runtime: RunRuntime, execution: Execution): Promise<void> {
    const outcome = await this.review(record, subject, runtime, execution);
    if (this.active.get(record.taskId)?.reviewId === record.id) this.active.delete(record.taskId);
    this.finish(record, subject.userId, outcome);
  }

  private async review(record: ReviewRecord, subject: ReviewSubject, runtime: RunRuntime, execution: Execution): Promise<Partial<ReviewRecord>> {
    const reposRoot = this.deps.reposRoot();
    const { controller } = execution;
    let checkout: PristineCheckout | null = null;
    let session: AgentSession | null = null;
    let endpoint: RuntimeEndpoint | null = null;
    const timeout = setTimeout(() => stopExecution(execution, 'timeout'), this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = () => {
      void session?.abort().catch(() => undefined);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      checkout = await createPristineCheckout({ reposRoot, runId: `review-${record.id}`, source: subject.worktreePath, commit: record.commit });
      const changedFiles = await changedFilesOf(checkout.path, record.baseCommit, record.commit);
      const diff = await diffOf(checkout.path, record.baseCommit, record.commit);
      record.diffTruncated = diff.truncated;
      const prompt = buildReviewPrompt({ task: subject.task, commit: record.commit, baseCommit: record.baseCommit, changedFiles, diff: diff.text, diffTruncated: diff.truncated });
      if (controller.signal.aborted) throw new ReviewStopped();
      const started = await runtime.start({
        runId: `review-${record.id}`,
        worktreePath: checkout.path,
        systemContract: REVIEWER_SYSTEM_CONTRACT,
        prompt,
        ...(subject.model ? { model: { id: subject.model, provider: subject.model.split('/')[0] } } : {}),
        budgets: { wallClockMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, ...(subject.maxUsd !== null ? { maxUsd: subject.maxUsd } : {}) },
        permissions: { default: 'deny' },
        sandbox: { cwd: checkout.path, env: {} },
        env: {},
        signal: controller.signal,
      });
      session = started.session;
      endpoint = started.endpoint;
      if (controller.signal.aborted) void session.abort().catch(() => undefined);
      const text = await this.consume(record, subject, session, execution);
      if (execution.stop) throw new ReviewStopped();
      const parsed = parseReviewOutput(text);
      if (!parsed.ok) return { status: 'failed', error: parsed.error };
      const usable = parsed.output.findings.filter((finding) => safeRepoPath(finding.file) !== null);
      const sourceCheckout = checkout.path;
      const findings = await anchorFindings(record.commit, usable, new Set(changedFiles), async (path) => (await readFileAtCommit(sourceCheckout, record.commit, path, MAX_FILE_BYTES)).text);
      return { status: 'completed', summary: parsed.output.summary, findings, dropped: parsed.output.findings.length - findings.length };
    } catch (error) {
      // The message only: some errors carry large payloads (git output, repository code).
      if (!(error instanceof ReviewStopped) && !execution.stop) logger.warn({ error: error instanceof Error ? error.message.slice(0, 500) : String(error), taskId: record.taskId, reviewId: record.id }, '[Reviewer] review failed');
      if (execution.stop === 'cancelled') return { status: 'cancelled', error: null };
      if (execution.stop === 'timeout') return { status: 'failed', error: 'The review did not finish in time' };
      if (execution.stop === 'budget') return { status: 'failed', error: `The review reached the run's cost budget ($${subject.maxUsd?.toFixed(2) ?? '0'})` };
      return { status: 'failed', error: error instanceof Error ? error.message.slice(0, 500) : 'The review failed' };
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener('abort', onAbort);
      if (endpoint) await runtime.release?.(endpoint).catch(() => undefined);
      if (checkout) {
        try {
          // The unresolved path: the returned one is a realpath (e.g. /private/var on macOS).
          removePristineCheckout(reposRoot, pristineCheckoutPath(reposRoot, `review-${record.id}`));
        } catch (error) {
          logger.warn({ err: error, reviewId: record.id }, '[Reviewer] could not remove the review checkout');
        }
      }
    }
  }

  /** The session's answer text; usage counted; permission requests denied; stops at the budget. */
  private async consume(record: ReviewRecord, subject: ReviewSubject, session: AgentSession, execution: Execution): Promise<string> {
    let text = '';
    const usage = new Map<string, { usd: number; input: number; output: number }>();
    let unnamed = 0;
    // Stop and the deadline abort the session; a stream that ignores that is
    // given a short grace period, then abandoned, so a review always ends.
    const iterator = (session.events as AsyncIterable<AgentEvent>)[Symbol.asyncIterator]();
    const { signal } = execution.controller;
    const abandoned = new Promise<'abandoned'>((resolve) => {
      const later = () => setTimeout(() => resolve('abandoned'), this.deps.abortGraceMs ?? ABORT_GRACE_MS).unref?.();
      if (signal.aborted) later();
      else signal.addEventListener('abort', later, { once: true });
    });
    for (;;) {
      const next = await Promise.race([iterator.next(), abandoned]);
      if (next === 'abandoned') {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        throw new ReviewStopped();
      }
      if (next.done) break;
      const event = next.value;
      if (event.t === 'message.delta') {
        text = appendReviewAnswer(text, event.text);
      } else if (event.t === 'permission.requested') {
        await session.replyPermission(event.id, 'deny', 'once').catch(() => undefined);
      } else if (event.t === 'usage') {
        unnamed += 1;
        usage.set(event.messageId ?? `unnamed-${unnamed}`, { usd: event.cost?.usd ?? 0, input: event.usage.input, output: event.usage.output });
        const totals = [...usage.values()].reduce((sum, entry) => ({ usd: sum.usd + entry.usd, input: sum.input + entry.input, output: sum.output + entry.output }), { usd: 0, input: 0, output: 0 });
        record.usage = { usd: totals.usd, inputTokens: totals.input, outputTokens: totals.output };
        if (subject.maxUsd !== null && totals.usd > subject.maxUsd) stopExecution(execution, 'budget');
      } else if (event.t === 'error') {
        throw new Error(`The reviewer stopped with an error: ${event.message.slice(0, 300)}`);
      } else if (event.t === 'turn.finished') {
        if (event.reason === 'error') throw new Error('The reviewer\'s turn ended with an error');
        if (event.reason === 'interrupted') throw new ReviewStopped();
        break;
      }
    }
    return text;
  }
}

function stopExecution(execution: Execution, reason: NonNullable<Execution['stop']>): void {
  execution.stop ??= reason;
  if (!execution.controller.signal.aborted) execution.controller.abort();
}

class ReviewStopped extends Error {
  constructor() {
    super('Review stopped');
    this.name = 'ReviewStopped';
  }
}
