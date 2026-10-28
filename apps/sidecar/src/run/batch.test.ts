import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTerminalRunState } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import { orderByDependencies, RunBatchCoordinator, toV2BatchStatusResponse } from './batch';
import { RunService, type RunServiceOptions } from './service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeWorkspace, fakeCredential, type HostStep } from './test-support';

/**
 * W13a: batches on the v2 run service — each member is an ordinary run with
 * its own attempt, lease and pull request; parallel batches respect the
 * parallel limit; queue batches advance on approve (or automatically), stop
 * on failure when asked; cancel reaches running and waiting members; a
 * restart keeps the batch and its members' results.
 */

const roots: string[] = [];
const stoppers: Array<() => void> = [];

afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OPTIONS: Partial<RunServiceOptions> = {
  heartbeatMs: 3_600_000,
  retryBaseMs: 5,
  retryMaxMs: 20,
  relayDelayMs: 0,
  relayRetryBaseMs: 5,
  relayRetryMaxMs: 20,
  interruptGraceMs: 0,
  startWaitMs: 10_000,
  watchdogIntervalMs: 20,
  watchdog: { transportMs: 1e9, noProgressMs: 1e9, wallClockMs: 1e9 },
};

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const FAIL: HostStep[] = [{ t: 'error', code: 'auth', message: 'bad key', retryable: false }];

function harness(taskIds: string[], parallelLimit = 3) {
  const root = mkdtempSync(join(tmpdir(), 'ol-batch-'));
  roots.push(root);
  const journalPath = join(root, 'journal', 'runs-v2.sqlite');
  const cp = new FakeControlPlane();
  cp.parallelLimit = parallelLimit;
  for (const id of taskIds) cp.addTask(id);
  const host = new FakeRuntimeHost();
  /** Scripts by session creation order (undefined = the default successful turn). */
  const plan: Array<HostStep[] | undefined> = [];
  let created = 0;
  const original = host.create.bind(host);
  host.create = (id, directory) => {
    const script = plan[created];
    created += 1;
    if (script) host.scripts.set(id, script);
    return original(id, directory);
  };
  const publication = new FakePublication();
  const workspace = new FakeWorkspace(join(root, 'worktrees'));
  const events: Array<{ userId: string; event: string; payload: Record<string, unknown> }> = [];

  function boot() {
    const journal = new DurableRunJournal(journalPath);
    const service = new RunService({
      journal,
      controlPlane: cp,
      runtimes: new Map([['opencode', new FakeRuntime(host)]]),
      publication,
      workspace,
      events: { publish: () => undefined },
      options: OPTIONS,
    });
    const batches = new RunBatchCoordinator({
      service,
      journal,
      events: { publish: (userId, event, payload) => events.push({ userId, event, payload }) },
      dependencies: (credential, ids) => cp.dependencyEdges(credential, ids),
    });
    stoppers.push(() => {
      batches.stop();
      service.stop();
      if (!journal.isClosed) journal.close();
    });
    return { service, journal, batches };
  }

  return { cp, host, plan, publication, events, boot, sessionsCreated: () => created };
}

function settledBatch(batches: RunBatchCoordinator, batchId: string) {
  return waitFor(() => {
    const view = batches.view(batchId);
    return view && view.batch.status !== 'running' ? view : null;
  }, `batch ${batchId} finished`);
}

describe('W13a parallel batches', () => {
  it('runs every member as its own verified run with its own pull request, within the parallel limit', async () => {
    const h = harness(['t1', 't2', 't3'], 2);
    const { batches, journal } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['t1', 't2', 't3'], mode: 'parallel', settings: { autoApprove: false, stopOnFailure: false } });
    expect(created.members.every((member) => member.runId !== null)).toBe(true);
    // The third run waits for a slot (parallel limit 2), then starts when one frees up.
    expect(created.members.map((member) => member.runState)).toEqual(['running', 'running', 'queued']);
    const third = created.members[2]?.runId ?? '';

    const done = await settledBatch(batches, created.batch.batchId);
    expect(journal.events(third, 0, 100).find((event) => event.kind === 'run.state')?.payload).toMatchObject({ to: 'preparing', reason: 'slot available' });
    expect(done.batch.status).toBe('completed');
    expect(done.members.map((member) => member.status)).toEqual(['completed', 'completed', 'completed']);
    const prs = done.members.map((member) => member.prUrl);
    expect(new Set(prs).size).toBe(3);
    expect(prs.every((url) => typeof url === 'string' && url.startsWith('https://github.com/'))).toBe(true);
    for (const id of ['t1', 't2', 't3']) expect(h.cp.tasks.get(id)).toMatchObject({ status: 'done' });
    // Each member had its own control-plane attempt.
    expect(new Set(['t1', 't2', 't3'].map((id) => h.cp.attemptFor(id)?.id)).size).toBe(3);
    expect(h.events.map((event) => event.event)).toEqual(expect.arrayContaining(['batch:created', 'batch:started', 'batch:task:completed', 'batch:completed']));
    expect(h.events.every((event) => event.userId === 'user-1')).toBe(true);

    const response = toV2BatchStatusResponse(done);
    expect(response).toMatchObject({ status: 'completed', mode: 'parallel', engine: 'v2', prUrl: null, progress: { total: 3, completed: 3, percentage: 100 } });
    expect(response.tasks.map((task) => task.title)).toEqual(['Task t1', 'Task t2', 'Task t3']);
    expect(response.tasks.every((task) => task.prUrl !== null && task.runId !== null && task.branch.startsWith('openlinear/'))).toBe(true);
  });

  it('a member the control plane refuses fails alone; the batch finishes as failed', async () => {
    const h = harness(['t1', 't3']);
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['t1', 'missing', 't3'], mode: 'parallel', settings: { autoApprove: false, stopOnFailure: false } });
    expect(created.members[1]).toMatchObject({ status: 'failed', runId: null, error: expect.stringContaining('TASK_NOT_FOUND') });
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.batch.status).toBe('failed');
    expect(done.members.map((member) => member.status)).toEqual(['completed', 'failed', 'completed']);
  });

  it('runs members the user staged in the In Progress column (the board flow)', async () => {
    const h = harness(['s1', 's2']);
    for (const id of ['s1', 's2']) {
      const task = h.cp.tasks.get(id);
      if (task) task.status = 'in_progress';
    }
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['s1', 's2'], mode: 'parallel', settings: { autoApprove: false, stopOnFailure: false } });
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.members.map((member) => member.status)).toEqual(['completed', 'completed']);
  });

  it('combined batches are refused on the v2 engine (no partial start)', async () => {
    const h = harness(['t1']);
    const { batches } = h.boot();
    await expect(batches.create({ credential: fakeCredential(), taskIds: ['t1'], mode: 'combined', settings: { autoApprove: false, stopOnFailure: false } }))
      .rejects.toMatchObject({ statusCode: 501, code: 'BATCH_MODE_UNAVAILABLE' });
    expect(h.cp.attemptFor('t1')).toBeUndefined();
  });
});

describe('W13a queue batches', () => {
  it('runs one member at a time and waits for approval between them', async () => {
    const h = harness(['q1', 'q2']);
    h.plan.push([{ hold: 'first' }, ...h.host.defaultScript()]);
    const { batches, service } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['q1', 'q2'], mode: 'queue', settings: { autoApprove: false, stopOnFailure: false } });
    const batchId = created.batch.batchId;
    expect(created.members.map((member) => member.runId !== null)).toEqual([true, false]);
    await waitFor(() => h.sessionsCreated() === 1 ? true : null, 'first session');
    await expect(batches.approveNext(batchId, fakeCredential())).rejects.toMatchObject({ code: 'BATCH_NOT_READY' });

    for (const session of h.host.sessions.values()) session.release('first');
    await waitFor(() => {
      const record = created.members[0]?.runId ? service.runRecord(created.members[0].runId) : null;
      return record && isTerminalRunState(record.state) ? true : null;
    }, 'first member');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const waiting = batches.view(batchId);
    expect(waiting?.batch.status).toBe('running');
    expect(waiting?.members.map((member) => member.status)).toEqual(['completed', 'queued']);

    const approved = await batches.approveNext(batchId, fakeCredential());
    expect(approved.members[1]?.runId).not.toBeNull();
    const done = await settledBatch(batches, batchId);
    expect(done.batch.status).toBe('completed');
    await expect(batches.approveNext(batchId, fakeCredential())).rejects.toMatchObject({ code: 'BATCH_NOT_RUNNING' });
  });

  it('auto-approve advances by itself; stop-on-failure skips the rest after a failure', async () => {
    const h = harness(['a1', 'a2', 'a3']);
    h.plan.push(undefined, FAIL);
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['a1', 'a2', 'a3'], mode: 'queue', settings: { autoApprove: true, stopOnFailure: true } });
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.batch.status).toBe('failed');
    expect(done.members.map((member) => member.status)).toEqual(['completed', 'failed', 'skipped']);
    expect(done.members[2]).toMatchObject({ runId: null, error: expect.stringContaining('did not succeed') });
    expect(h.cp.attemptFor('a3')).toBeUndefined();
    expect(h.events.filter((event) => event.event === 'batch:task:skipped').map((event) => event.payload.taskId)).toEqual(['a3']);
  });

  it('cancel stops the running member and cancels the waiting ones', async () => {
    const h = harness(['c1', 'c2']);
    h.plan.push([{ hold: 'never' }]);
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['c1', 'c2'], mode: 'queue', settings: { autoApprove: true, stopOnFailure: false } });
    await waitFor(() => h.sessionsCreated() === 1 ? true : null, 'first session');
    await batches.cancel(created.batch.batchId);
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.batch.status).toBe('cancelled');
    expect(done.members.map((member) => member.status)).toEqual(['cancelled', 'cancelled']);
    expect(h.cp.attemptFor('c2')).toBeUndefined();
    expect(h.events.some((event) => event.event === 'batch:cancelled')).toBe(true);
  });

  it('a restart keeps the batch: finished members stay finished and the queue continues on approve', async () => {
    const h = harness(['r1', 'r2']);
    const first = h.boot();
    const created = await first.batches.create({ credential: fakeCredential(), taskIds: ['r1', 'r2'], mode: 'queue', settings: { autoApprove: true, stopOnFailure: false } });
    const batchId = created.batch.batchId;
    // Let the first member finish, then "restart" before the auto-advance could use the in-memory credential.
    await waitFor(() => first.batches.view(batchId)?.members[0]?.status === 'completed' ? true : null, 'first member');
    await waitFor(() => first.batches.view(batchId)?.members[1]?.runId ? true : null, 'auto-advance');
    const restartedBefore = first.batches.view(batchId);
    expect(restartedBefore?.members[1]?.runId).not.toBeNull();
    await settledBatch(first.batches, batchId);
    for (const stop of stoppers.splice(0)) stop();

    const second = h.boot();
    await second.service.recover();
    await second.batches.recover();
    const view = second.batches.view(batchId);
    expect(view?.batch.status).toBe('completed');
    expect(view?.members.map((member) => member.status)).toEqual(['completed', 'completed']);
  });

  it('after a restart a queue whose next member never started waits for approve (no stored credential)', async () => {
    const h = harness(['w1', 'w2']);
    const first = h.boot();
    const created = await first.batches.create({ credential: fakeCredential(), taskIds: ['w1', 'w2'], mode: 'queue', settings: { autoApprove: false, stopOnFailure: false } });
    const batchId = created.batch.batchId;
    await waitFor(() => first.batches.view(batchId)?.members[0]?.status === 'completed' ? true : null, 'first member');
    for (const stop of stoppers.splice(0)) stop();

    const second = h.boot();
    await second.service.recover();
    await second.batches.recover();
    expect(second.batches.view(batchId)).toMatchObject({ batch: { status: 'running' } });
    expect(second.batches.active('user-1').map((view) => view.batch.batchId)).toEqual([batchId]);
    await second.batches.approveNext(batchId, fakeCredential());
    const done = await settledBatch(second.batches, batchId);
    expect(done.batch.status).toBe('completed');
  });
});

describe('W17a batches honour "blocked by"', () => {
  it('orders a task after its in-batch blockers (stable otherwise) and refuses cycles', () => {
    expect(orderByDependencies(['b', 'a', 'c'], [{ taskId: 'b', dependsOnTaskId: 'a' }])).toEqual({ order: ['a', 'b', 'c'], dependsOn: { b: ['a'] } });
    // Edges to tasks outside the batch don't reorder it.
    expect(orderByDependencies(['b', 'c'], [{ taskId: 'b', dependsOnTaskId: 'x' }]).order).toEqual(['b', 'c']);
    expect(() => orderByDependencies(['a', 'b'], [{ taskId: 'a', dependsOnTaskId: 'b' }, { taskId: 'b', dependsOnTaskId: 'a' }])).toThrow(expect.objectContaining({ code: 'DEPENDENCY_CYCLE' }));
  });

  it('parallel: a member waits for its in-batch blocker, then starts; independent members run at once', async () => {
    const h = harness(['a', 'b', 'c']);
    h.cp.edges.push({ taskId: 'b', dependsOnTaskId: 'a' });
    h.plan.push([{ hold: 'first' }, ...h.host.defaultScript()]);
    const { batches, service } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['b', 'a', 'c'], mode: 'parallel', settings: { autoApprove: false, stopOnFailure: false } });
    const batchId = created.batch.batchId;
    expect(created.members.map((member) => member.taskId)).toEqual(['a', 'b', 'c']);
    expect(created.members.map((member) => member.runId !== null)).toEqual([true, false, true]);
    expect(created.members[1]).toMatchObject({ status: 'queued', blockedBy: ['a'] });
    // Nothing to approve while the blocker runs.
    await expect(batches.approveNext(batchId, fakeCredential())).rejects.toMatchObject({ code: 'BATCH_NOT_READY' });

    for (const session of h.host.sessions.values()) session.release('first');
    const done = await settledBatch(batches, batchId);
    expect(done.batch.status).toBe('completed');
    expect(done.members.map((member) => member.status)).toEqual(['completed', 'completed', 'completed']);
    const blocker = service.runRecord(done.members[0]?.runId ?? '');
    const dependent = service.runRecord(done.members[1]?.runId ?? '');
    expect(dependent?.createdAt ?? 0).toBeGreaterThanOrEqual(blocker?.finishedAt ?? Number.POSITIVE_INFINITY);
    // The control-plane gate passed on its own: the blocker was done by then.
    expect(h.cp.allowBlockedStarts).toEqual([]);
    expect(toV2BatchStatusResponse(done).tasks.map((task) => task.blockedBy)).toEqual([[], ['a'], []]);
  });

  it('parallel: when a blocker fails, the members waiting on it are skipped; the rest finish', async () => {
    const h = harness(['a', 'b', 'c', 'd']);
    h.cp.edges.push({ taskId: 'b', dependsOnTaskId: 'a' }, { taskId: 'd', dependsOnTaskId: 'b' });
    h.plan.push(FAIL);
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['a', 'b', 'c', 'd'], mode: 'parallel', settings: { autoApprove: false, stopOnFailure: false } });
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.batch.status).toBe('failed');
    expect(done.members.map((member) => [member.taskId, member.status])).toEqual([['a', 'failed'], ['b', 'skipped'], ['c', 'completed'], ['d', 'skipped']]);
    expect(done.members[1]).toMatchObject({ runId: null, error: expect.stringContaining('blocked by Task a') });
    expect(done.members[3]).toMatchObject({ runId: null, error: 'Skipped: a task it is blocked by in this batch did not finish' });
    expect(h.cp.attemptFor('b')).toBeUndefined();
    expect(h.cp.attemptFor('d')).toBeUndefined();
  });

  it('queue: runs blockers first even when listed later', async () => {
    const h = harness(['a', 'b']);
    h.cp.edges.push({ taskId: 'a', dependsOnTaskId: 'b' });
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['a', 'b'], mode: 'queue', settings: { autoApprove: true, stopOnFailure: false } });
    expect(created.members.map((member) => member.taskId)).toEqual(['b', 'a']);
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.members.map((member) => member.status)).toEqual(['completed', 'completed']);
  });

  it('a member with an open blocker outside the batch fails with TASK_BLOCKED; the others run', async () => {
    const h = harness(['a', 'b', 'outside']);
    h.cp.edges.push({ taskId: 'a', dependsOnTaskId: 'outside' });
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['a', 'b'], mode: 'parallel', settings: { autoApprove: false, stopOnFailure: false } });
    expect(created.members[0]).toMatchObject({ status: 'failed', runId: null, error: expect.stringContaining('TASK_BLOCKED') });
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.members.map((member) => member.status)).toEqual(['failed', 'completed']);
  });

  it('single runs: blocked unless run anyway; follow-ups are never blocked', async () => {
    const h = harness(['a', 'b']);
    h.cp.edges.push({ taskId: 'a', dependsOnTaskId: 'b' });
    const { service } = h.boot();
    await expect(service.submit({ credential: fakeCredential(), taskId: 'a' })).rejects.toMatchObject({ statusCode: 409, code: 'TASK_BLOCKED', details: { blockers: [{ id: 'b' }] } });
    const started = await service.submit({ credential: fakeCredential(), taskId: 'a', allowBlocked: true });
    expect(h.cp.allowBlockedStarts).toEqual(['a']);
    await waitFor(() => {
      const record = service.runRecord(started.runId);
      return record && isTerminalRunState(record.state) ? true : null;
    }, 'run anyway');
    await service.followUp({ credential: fakeCredential(), taskId: 'a', request: { message: 'one more thing', comments: [] } });
    expect(h.cp.allowBlockedStarts).toEqual(['a', 'a']);
  });
});

describe('review fixes: cancel during start, stop on failure at start', () => {
  it('cancelling a member whose start is in flight cancels its run (never "cancelled" while it keeps going)', async () => {
    const h = harness(['a']);
    h.plan.push([{ hold: 'never' }]);
    const { batches, service, journal } = h.boot();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let submitting = false;
    const realSubmit = service.submit.bind(service);
    service.submit = async (input) => {
      submitting = true;
      await gate;
      return realSubmit(input);
    };
    const creating = batches.create({ credential: fakeCredential(), taskIds: ['a'], mode: 'parallel', settings: { autoApprove: false, stopOnFailure: false } });
    await waitFor(() => submitting ? true : null, 'submit in flight');
    const batchId = journal.listBatches({ status: 'running' })[0]?.batchId ?? '';
    const cancelling = batches.cancelTask(batchId, 'a');
    release();
    await creating;
    await cancelling;
    const done = await settledBatch(batches, batchId);
    const member = done.members[0];
    expect(member?.runId).toBeTruthy();
    expect(member?.status).toBe('cancelled');
    expect(service.runRecord(member?.runId ?? '')?.state).toBe('cancelled');
  });

  it('stop on failure also stops the queue when a member is refused at start', async () => {
    const h = harness(['b', 'c']);
    const { batches } = h.boot();
    const created = await batches.create({ credential: fakeCredential(), taskIds: ['missing', 'b', 'c'], mode: 'queue', settings: { autoApprove: true, stopOnFailure: true } });
    const done = await settledBatch(batches, created.batch.batchId);
    expect(done.members.map((member) => member.status)).toEqual(['failed', 'skipped', 'skipped']);
    expect(done.members[1]?.error).toContain('did not start');
    expect(h.cp.attemptFor('b')).toBeUndefined();
    expect(h.cp.attemptFor('c')).toBeUndefined();
  });
});

