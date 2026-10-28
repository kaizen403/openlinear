import { randomUUID } from 'node:crypto';
import {
  isTerminalRunState,
  type BatchMode,
  type BatchProgressSummary,
  type BatchStatus,
  type BatchStatusResponse,
  type CreateBatchResponse,
  type RunState,
} from '@openlinear/execution-core';
import type { PrincipalCredential } from '../auth/principal';
import type { BatchMemberRecord, BatchMemberStatus, BatchRecord, DurableRunJournal, RunRecord } from '../journal/durable';
import { HttpError, isHttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import type { RunService } from './service';

/**
 * W13a: batches on the v2 run service.
 *
 * A batch is a coordinated set of ordinary v2 runs — one per task — so every
 * member gets the same lease, heartbeat, sandbox, verification (W11a), cancel
 * and recovery as a single run, and publishes its own verified pull request.
 *
 * - `parallel`: every member is submitted at once; the run service's
 *   parallel limit (the user's execution setting) bounds how many run, the
 *   rest wait in its queue (`queued`).
 * - `queue`: one member at a time, in order. The next one starts when the
 *   previous settles — automatically with `autoApprove`, otherwise on
 *   `approve` (the caller's credential starts it). `stopOnFailure` skips the
 *   rest after a member that did not succeed.
 * - `combined` (one agent session and one pull request for every task) is not
 *   available on the v2 engine yet: refused with BATCH_MODE_UNAVAILABLE.
 *
 * W17a "blocked by": members are ordered so a task never precedes its
 * in-batch blockers, and a member starts only after every in-batch blocker
 * completed; when a blocker fails, is cancelled or skipped, the members
 * waiting on it are skipped. Blockers outside the batch are the control
 * plane's gate (a member with an open one fails with TASK_BLOCKED).
 *
 * Durable: batches and members live in the run journal. After a restart,
 * members' runs are recovered by the run service itself; a queue whose next
 * member had not started waits for `approve` (the creator's credential is
 * kept in memory only, never on disk).
 */

export interface BatchCoordinatorSettings {
  autoApprove: boolean;
  stopOnFailure: boolean;
}

export const MAX_BATCH_TASKS = 20;

type RunServicePort = Pick<RunService, 'submit' | 'cancel' | 'runRecord' | 'onRunSettled'>;

export interface BatchEventSink {
  publish(userId: string, event: string, payload: Record<string, unknown>): void;
}

export interface BatchView {
  batch: BatchRecord;
  members: Array<BatchMemberRecord & {
    status: BatchMemberStatus;
    runState: RunState | null;
    prUrl: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    /** W17a: in-batch tasks this member waits on. */
    blockedBy: string[];
  }>;
}

export interface DependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
}

/**
 * W17a: a stable topological order — the given order, except that a task
 * never precedes one of its in-batch blockers — plus each task's in-batch
 * blockers. Edges to tasks outside the batch are ignored here.
 */
export function orderByDependencies(taskIds: readonly string[], edges: readonly DependencyEdge[]): { order: string[]; dependsOn: Record<string, string[]> } {
  const listed = new Set(taskIds);
  const dependsOn: Record<string, string[]> = {};
  for (const edge of edges) {
    if (edge.taskId === edge.dependsOnTaskId || !listed.has(edge.taskId) || !listed.has(edge.dependsOnTaskId)) continue;
    const blockers = dependsOn[edge.taskId] ?? [];
    if (!blockers.includes(edge.dependsOnTaskId)) blockers.push(edge.dependsOnTaskId);
    dependsOn[edge.taskId] = blockers;
  }
  const placed = new Set<string>();
  const order: string[] = [];
  while (order.length < taskIds.length) {
    const next = taskIds.find((id) => !placed.has(id) && (dependsOn[id] ?? []).every((blocker) => placed.has(blocker)));
    if (next === undefined) {
      throw new HttpError(409, 'DEPENDENCY_CYCLE', 'Some of these tasks block each other in a cycle; remove one of the dependencies first');
    }
    placed.add(next);
    order.push(next);
  }
  return { order, dependsOn };
}

function dependsOnOf(batch: BatchRecord): Record<string, string[]> {
  const raw = batch.settings.dependsOn;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, string[]> = {};
  for (const [taskId, blockers] of Object.entries(raw)) {
    if (Array.isArray(blockers)) result[taskId] = blockers.filter((value): value is string => typeof value === 'string');
  }
  return result;
}

const UNFINISHED: ReadonlySet<BatchMemberStatus> = new Set<BatchMemberStatus>(['failed', 'cancelled', 'skipped']);

/** execution-core `getBatchProgressSummary`, over member statuses. */
export function batchProgress(statuses: readonly BatchMemberStatus[]): BatchProgressSummary {
  const count = (status: BatchMemberStatus) => statuses.filter((value) => value === status).length;
  const completed = count('completed');
  const failed = count('failed');
  const skipped = count('skipped');
  const cancelled = count('cancelled');
  const total = statuses.length;
  return {
    total, completed, failed, running: count('running'), queued: count('queued'), skipped, cancelled,
    percentage: total > 0 ? Math.round(((completed + failed + skipped + cancelled) / total) * 100) : 0,
  };
}

const RUNNING_STATES: ReadonlySet<RunState> = new Set<RunState>(['preparing', 'running', 'awaiting_approval', 'compacting', 'verifying', 'finishing']);

function memberStatusFor(member: BatchMemberRecord, run: RunRecord | null): BatchMemberStatus {
  if (member.finalStatus) return member.finalStatus;
  if (member.outcome) return member.outcome;
  if (!member.runId) return 'queued';
  if (!run) return 'failed';
  if (run.state === 'queued') return 'queued';
  if (RUNNING_STATES.has(run.state)) return 'running';
  if (run.state === 'succeeded') return 'completed';
  if (run.state === 'cancelled') return 'cancelled';
  return 'failed';
}

/** Not started and not settled: waiting for its turn (or its blockers). */
function isWaiting(member: { status: BatchMemberStatus; runId: string | null }): boolean {
  return member.status === 'queued' && !member.runId;
}

function errorText(error: unknown): string {
  if (isHttpError(error)) return `${error.code}: ${error.message}`.slice(0, 1_000);
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

export class RunBatchCoordinator {
  /** Creator credentials, in memory only (queue auto-advance). */
  private readonly credentials = new Map<string, PrincipalCredential>();
  /** Serializes advance/finish per batch. */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly unsubscribe: () => void;

  constructor(private readonly deps: {
    service: RunServicePort;
    journal: Pick<DurableRunJournal, 'createBatch' | 'getBatch' | 'listBatches' | 'batchMemberForRun' | 'updateBatchMember' | 'requestBatchCancel' | 'finishBatch'>;
    events?: BatchEventSink;
    /** W17a: "blocked by" edges among the batch's tasks (absent: no ordering). */
    dependencies?: (credential: PrincipalCredential, taskIds: readonly string[]) => Promise<DependencyEdge[]>;
    now?: () => number;
  }) {
    this.unsubscribe = deps.service.onRunSettled((record) => this.onRunSettled(record));
  }

  stop(): void {
    this.unsubscribe();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private withLock(batchId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(batchId) ?? Promise.resolve();
    const next = previous.then(work, work).catch((error: unknown) => {
      logger.error({ err: error, batchId }, '[Batch] coordinator step failed');
    });
    this.locks.set(batchId, next);
    void next.finally(() => {
      if (this.locks.get(batchId) === next) this.locks.delete(batchId);
    });
    return next;
  }

  private emit(batch: BatchRecord, event: string, data: Record<string, unknown> = {}): void {
    try {
      this.deps.events?.publish(batch.userId, event, { batchId: batch.batchId, ...data, timestamp: new Date(this.now()).toISOString() });
    } catch (error) {
      logger.warn({ err: error, batchId: batch.batchId, event }, '[Batch] event broadcast failed');
    }
  }

  // --- reads ------------------------------------------------------------------

  view(batchId: string): BatchView | null {
    const found = this.deps.journal.getBatch(batchId);
    if (!found) return null;
    const dependsOn = dependsOnOf(found.batch);
    const members = found.members.map((member) => {
      const run = member.runId ? this.deps.service.runRecord(member.runId) : null;
      return {
        ...member,
        title: member.title || run?.snapshot.title || '',
        status: memberStatusFor(member, run),
        runState: run?.state ?? null,
        prUrl: run?.terminal?.prUrl ?? null,
        startedAt: run ? run.createdAt : null,
        finishedAt: run?.finishedAt ?? null,
        blockedBy: dependsOn[member.taskId] ?? [],
      };
    });
    return { batch: found.batch, members };
  }

  /** Running batches of a user (`GET /api/batches`). */
  active(userId: string): BatchView[] {
    return this.deps.journal.listBatches({ status: 'running', userId })
      .map((batch) => this.view(batch.batchId))
      .filter((view): view is BatchView => view !== null);
  }

  // --- commands ---------------------------------------------------------------

  async create(input: { credential: PrincipalCredential; taskIds: string[]; mode: BatchMode; settings: BatchCoordinatorSettings }): Promise<BatchView> {
    const { credential, taskIds, mode } = input;
    if (mode === 'combined') {
      throw new HttpError(501, 'BATCH_MODE_UNAVAILABLE', 'Combined batches are not available on this execution engine yet; run the tasks in Parallel or Queue mode', { mode });
    }
    if (taskIds.length === 0 || taskIds.length > MAX_BATCH_TASKS || new Set(taskIds).size !== taskIds.length) {
      throw new HttpError(400, 'INVALID_BATCH', `A batch needs 1 to ${MAX_BATCH_TASKS} distinct tasks`);
    }
    const edges = this.deps.dependencies ? await this.deps.dependencies(credential, taskIds) : [];
    const { order, dependsOn } = orderByDependencies(taskIds, edges);
    const batchId = randomUUID();
    const batch = this.deps.journal.createBatch({
      batchId,
      userId: credential.principal.userId,
      mode,
      settings: { ...input.settings, ...(Object.keys(dependsOn).length > 0 ? { dependsOn } : {}) },
      taskIds: order,
    }, this.now());
    this.credentials.set(batchId, credential);
    this.emit(batch, 'batch:created', { mode, taskIds: order });
    await this.withLock(batchId, async () => {
      if (mode === 'parallel') {
        // Members with in-batch blockers wait; `progress` starts them.
        for (let position = 0; position < order.length; position += 1) {
          const taskId = order[position];
          if (taskId !== undefined && (dependsOn[taskId] ?? []).length === 0) await this.startMember(batchId, position, credential);
        }
      } else {
        await this.startMember(batchId, 0, credential);
      }
      this.emit(batch, 'batch:started');
      await this.progress(batchId);
    });
    const view = this.view(batchId);
    if (!view) throw new HttpError(500, 'BATCH_LOST', 'The batch was not recorded');
    return view;
  }

  /** Submit one member; a refused submit (already running, archived, no model…) fails just that member. */
  private async startMember(batchId: string, position: number, credential: PrincipalCredential): Promise<void> {
    const found = this.deps.journal.getBatch(batchId);
    const member = found?.members.find((item) => item.position === position);
    if (!found || !member || member.runId || member.outcome) return;
    try {
      const started = await this.deps.service.submit({ credential, taskId: member.taskId });
      this.deps.journal.updateBatchMember(batchId, position, { runId: started.runId }, this.now());
      const run = this.deps.service.runRecord(started.runId);
      if (run?.snapshot.title) this.deps.journal.updateBatchMember(batchId, position, { title: run.snapshot.title }, this.now());
      this.emit(found.batch, 'batch:task:started', { taskId: member.taskId, runId: started.runId });
    } catch (error) {
      logger.warn({ err: error, batchId, taskId: member.taskId }, '[Batch] member could not start');
      this.deps.journal.updateBatchMember(batchId, position, { outcome: 'failed', error: errorText(error) }, this.now());
      this.emit(found.batch, 'batch:task:failed', { taskId: member.taskId, error: errorText(error) });
    }
  }

  async approveNext(batchId: string, credential: PrincipalCredential): Promise<BatchView> {
    const view = this.view(batchId);
    if (!view) throw new HttpError(404, 'NOT_FOUND', 'Batch not found');
    if (view.batch.status !== 'running' || view.batch.cancelRequestedAt !== null) throw new HttpError(409, 'BATCH_NOT_RUNNING', 'This batch is no longer running');
    if (view.batch.mode === 'parallel') {
      // After a restart (no stored credential), waiting members whose
      // blockers completed start on approve.
      const waiting = view.members.some(isWaiting);
      const ready = view.members.filter((member) => isWaiting(member) && this.isReady(view, member));
      if (ready.length === 0) {
        throw waiting
          ? new HttpError(409, 'BATCH_NOT_READY', 'The waiting tasks are still blocked by running tasks')
          : new HttpError(409, 'NO_QUEUED_TASK', 'There are no queued tasks left to approve');
      }
      this.credentials.set(batchId, credential);
      await this.withLock(batchId, async () => {
        for (const member of ready) await this.startMember(batchId, member.position, credential);
        await this.progress(batchId);
      });
      return this.view(batchId) ?? view;
    }
    if (view.batch.mode !== 'queue') throw new HttpError(409, 'BATCH_NOT_READY', 'Only queue batches wait for approval');
    if (view.members.some((member) => member.status === 'running' || (member.runId && member.status === 'queued'))) {
      throw new HttpError(409, 'BATCH_NOT_READY', 'The current task is still running');
    }
    const next = view.members.find(isWaiting);
    if (!next) throw new HttpError(409, 'NO_QUEUED_TASK', 'There are no queued tasks left to approve');
    if (!this.isReady(view, next)) throw new HttpError(409, 'BATCH_NOT_READY', 'The next task is still blocked by an unfinished task');
    // The approver's fresh credential also serves later auto-advances.
    this.credentials.set(batchId, credential);
    await this.withLock(batchId, async () => {
      await this.startMember(batchId, next.position, credential);
      await this.progress(batchId);
    });
    return this.view(batchId) ?? view;
  }

  async cancel(batchId: string): Promise<void> {
    const view = this.view(batchId);
    if (!view) throw new HttpError(404, 'NOT_FOUND', 'Batch not found');
    if (view.batch.status !== 'running') return;
    this.deps.journal.requestBatchCancel(batchId, this.now());
    await this.withLock(batchId, async () => {
      const current = this.view(batchId);
      if (!current) return;
      for (const member of current.members) {
        if (!member.runId && member.status === 'queued') {
          this.deps.journal.updateBatchMember(batchId, member.position, { outcome: 'cancelled', error: 'The batch was cancelled before this task started' }, this.now());
          this.emit(current.batch, 'batch:task:cancelled', { taskId: member.taskId });
        }
      }
    });
    const running = (this.view(batchId)?.members ?? []).filter((member) => member.runId && (member.status === 'running' || member.status === 'queued'));
    await Promise.all(running.map((member) => this.deps.service.cancel(member.taskId, 'batch cancelled').catch((error: unknown) => {
      logger.warn({ err: error, batchId, taskId: member.taskId }, '[Batch] member cancel failed');
    })));
    this.emit(view.batch, 'batch:cancelled');
    await this.withLock(batchId, () => this.finishIfDone(batchId));
  }

  async cancelTask(batchId: string, taskId: string): Promise<void> {
    if (!this.view(batchId)?.members.some((item) => item.taskId === taskId)) throw new HttpError(404, 'NOT_FOUND', 'Task not found in this batch');
    // Decide under the batch lock: a member whose start is in flight (submit
    // awaiting workspace prep) gets its run id before we look, so its run is
    // cancelled instead of being marked "cancelled" while it keeps going.
    let runToCancel = false;
    await this.withLock(batchId, async () => {
      const view = this.view(batchId);
      const member = view?.members.find((item) => item.taskId === taskId);
      if (!view || !member) return;
      if (member.runId) {
        runToCancel = true;
        return;
      }
      if (member.status !== 'queued') return;
      this.deps.journal.updateBatchMember(batchId, member.position, { outcome: 'cancelled', error: 'Cancelled before it started' }, this.now());
      this.emit(view.batch, 'batch:task:cancelled', { taskId });
      // Members waiting on it are skipped (W17a).
      await this.progress(batchId);
    });
    if (runToCancel) await this.deps.service.cancel(taskId, 'cancelled in batch');
  }

  /** Boot: finish batches whose members all settled while the process was down. */
  async recover(): Promise<{ batches: number }> {
    const running = this.deps.journal.listBatches({ status: 'running' });
    for (const batch of running) await this.withLock(batch.batchId, () => this.progress(batch.batchId));
    return { batches: running.length };
  }

  // --- progression ------------------------------------------------------------

  private onRunSettled(record: RunRecord): void {
    let member: BatchMemberRecord | null;
    try {
      member = this.deps.journal.batchMemberForRun(record.runId);
    } catch (error) {
      logger.warn({ err: error, runId: record.runId }, '[Batch] member lookup failed');
      return;
    }
    if (!member) return;
    const { batchId } = member;
    const found = this.deps.journal.getBatch(batchId);
    if (found) {
      const status = memberStatusFor(member, record);
      this.emit(found.batch, status === 'completed' ? 'batch:task:completed' : status === 'cancelled' ? 'batch:task:cancelled' : 'batch:task:failed', {
        taskId: member.taskId, runId: record.runId, prUrl: record.terminal?.prUrl ?? null,
      });
    }
    void this.withLock(batchId, () => this.advance(batchId, member as BatchMemberRecord, record));
  }

  private async advance(batchId: string, settled: BatchMemberRecord, record: RunRecord): Promise<void> {
    const view = this.view(batchId);
    if (view?.batch.status !== 'running') return;
    const settings = view.batch.settings;
    const failed = record.state !== 'succeeded';
    if (view.batch.cancelRequestedAt === null && failed && settings.stopOnFailure === true) {
      for (const member of view.members) {
        if (!member.runId && member.status === 'queued') {
          this.deps.journal.updateBatchMember(batchId, member.position, { outcome: 'skipped', error: `Skipped: ${settled.title || 'an earlier task'} did not succeed` }, this.now());
          this.emit(view.batch, 'batch:task:skipped', { taskId: member.taskId });
        }
      }
    }
    await this.progress(batchId);
  }

  /** W17a: every in-batch blocker completed. */
  private isReady(view: BatchView, member: BatchView['members'][number]): boolean {
    return member.blockedBy.every((taskId) => view.members.find((other) => other.taskId === taskId)?.status === 'completed');
  }

  /**
   * Skip waiting members whose in-batch blocker did not complete, start what
   * may start (parallel: every ready member; queue on auto-approve: the next
   * one once nothing runs), repeat until nothing changes, then finish the
   * batch if everything settled. Without a stored credential (after a
   * restart) nothing starts until `approve`.
   */
  private async progress(batchId: string): Promise<void> {
    for (let round = 0; round <= MAX_BATCH_TASKS * 2; round += 1) {
      const view = this.view(batchId);
      if (view?.batch.status !== 'running') return;
      let skipped = false;
      // Stop on failure also covers a member refused at start (TASK_BLOCKED,
      // archived, admission): it never settles as a run, so `advance` can't see it.
      const notStarted = view.batch.cancelRequestedAt === null && view.batch.settings.stopOnFailure === true
        ? view.members.find((member) => !member.runId && member.status === 'failed')
        : undefined;
      if (notStarted) {
        for (const member of view.members) {
          if (!isWaiting(member)) continue;
          this.deps.journal.updateBatchMember(batchId, member.position, { outcome: 'skipped', error: `Skipped: ${notStarted.title || 'an earlier task'} did not start` }, this.now());
          this.emit(view.batch, 'batch:task:skipped', { taskId: member.taskId });
          skipped = true;
        }
        if (skipped) continue;
      }
      for (const member of view.members) {
        if (!isWaiting(member)) continue;
        const failedBlocker = member.blockedBy
          .map((taskId) => view.members.find((other) => other.taskId === taskId))
          .find((other) => other !== undefined && UNFINISHED.has(other.status));
        if (!failedBlocker) continue;
        this.deps.journal.updateBatchMember(batchId, member.position, {
          outcome: 'skipped',
          error: failedBlocker.title
            ? `Skipped: it is blocked by ${failedBlocker.title}, which did not finish`
            : 'Skipped: a task it is blocked by in this batch did not finish',
        }, this.now());
        this.emit(view.batch, 'batch:task:skipped', { taskId: member.taskId, blockedBy: failedBlocker.taskId });
        skipped = true;
      }
      if (skipped) continue;
      const credential = this.credentials.get(batchId);
      if (view.batch.cancelRequestedAt !== null || !credential) break;
      let startable: BatchView['members'] = [];
      if (view.batch.mode === 'parallel') {
        startable = view.members.filter((member) => isWaiting(member) && this.isReady(view, member));
      } else if (view.batch.settings.autoApprove === true && !view.members.some((member) => member.runId && (member.status === 'running' || member.status === 'queued'))) {
        const next = view.members.find(isWaiting);
        if (next && this.isReady(view, next)) startable = [next];
      }
      if (startable.length === 0) break;
      for (const member of startable) await this.startMember(batchId, member.position, credential);
    }
    await this.finishIfDone(batchId);
  }

  private async finishIfDone(batchId: string): Promise<void> {
    const view = this.view(batchId);
    if (view?.batch.status !== 'running') return;
    const pending = view.members.some((member) => {
      if (member.runId) {
        const run = this.deps.service.runRecord(member.runId);
        return run !== null && !isTerminalRunState(run.state);
      }
      // A queue member that hasn't started yet keeps the batch open (it waits for approve).
      return member.status === 'queued';
    });
    if (pending) return;
    const statuses = view.members.map((member) => member.status);
    const status: Exclude<BatchStatus, 'pending' | 'running' | 'merging'> = view.batch.cancelRequestedAt !== null
      ? 'cancelled'
      : statuses.every((value) => value === 'completed') ? 'completed' : 'failed';
    const finished = this.deps.journal.finishBatch(batchId, status, view.members.map((member) => ({ position: member.position, status: member.status })), this.now());
    if (!finished) return;
    this.credentials.delete(batchId);
    const progress = batchProgress(statuses);
    this.emit(view.batch, status === 'completed' ? 'batch:completed' : status === 'cancelled' ? 'batch:cancelled' : 'batch:failed', { progress });
    logger.info({ batchId, status, members: statuses }, '[Batch] finished');
  }
}

// ---------------------------------------------------------------------------
// Response shapes (execution-core contracts the desktop UI already reads)
// ---------------------------------------------------------------------------

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function branchOf(member: BatchView['members'][number]): string {
  return member.runId ? `openlinear/${member.runId}` : '';
}

export function toV2CreateBatchResponse(view: BatchView): CreateBatchResponse {
  return {
    id: view.batch.batchId,
    status: view.batch.status,
    mode: view.batch.mode,
    tasks: view.members.map((member) => ({ taskId: member.taskId, title: member.title, status: member.status, branch: branchOf(member) })),
    createdAt: new Date(view.batch.createdAt).toISOString(),
  };
}

export type V2BatchStatusResponse = Omit<BatchStatusResponse, 'tasks'> & {
  engine: 'v2';
  tasks: Array<BatchStatusResponse['tasks'][number] & { prUrl: string | null; runId: string | null; blockedBy: string[] }>;
};

/** Status response; per-member `prUrl`/`runId` are additive (each member publishes its own pull request). */
export function toV2BatchStatusResponse(view: BatchView): V2BatchStatusResponse {
  const tasks = view.members.map((member) => ({
    taskId: member.taskId,
    title: member.title,
    status: member.status,
    branch: branchOf(member),
    error: member.error,
    startedAt: iso(member.startedAt),
    completedAt: iso(member.finishedAt),
    prUrl: member.prUrl,
    runId: member.runId,
    blockedBy: member.blockedBy,
  }));
  return {
    id: view.batch.batchId,
    status: view.batch.status,
    mode: view.batch.mode,
    engine: 'v2',
    tasks,
    prUrl: null,
    createdAt: new Date(view.batch.createdAt).toISOString(),
    completedAt: iso(view.batch.finishedAt),
    progress: batchProgress(tasks.map((task) => task.status)),
  };
}
