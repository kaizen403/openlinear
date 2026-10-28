import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTerminalRunState } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import { snapshotFromTask } from './control-plane';
import { RunService, type RunServiceOptions } from './service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeWorkspace, fakeCredential, fakeSnapshot, type HostStep } from './test-support';

/**
 * FE-04 at the service level: with the sealed approval mode "ask" and an
 * interactive runner, sessions start with `permissions.default: 'ask'` and
 * each permission request waits for the person who started the run — their
 * answer (quoting the operation digest) is what the runner gets; nobody
 * else can see or answer it; no answer in time is a deny; a cancel denies
 * and stops. "auto" (and a policy-only runner) answer by policy as before.
 */

const roots: string[] = [];
const services: RunService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TEST_OPTIONS: Partial<RunServiceOptions> = {
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

/** Asks once (`bash: rm -rf build`), waits for the reply, then edits and finishes. */
const ASKING: HostStep[] = [
  { t: 'turn.started', turn: 1 },
  { t: 'permission.requested', id: 'perm-1', tool: 'bash', detail: 'rm -rf build' },
  { hold: 'reply:perm-1' },
  { writeFile: 'change.txt' },
  { t: 'file.changed', path: 'change.txt', kind: 'create' },
  { t: 'turn.finished', turn: 1, reason: 'idle' },
];

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function harness(approvalMode: 'auto' | 'ask' | undefined, options: Partial<RunServiceOptions> = {}, script: HostStep[] = ASKING) {
  const root = mkdtempSync(join(tmpdir(), 'ol-approvals-svc-'));
  roots.push(root);
  const cp = new FakeControlPlane();
  cp.snapshot = (taskId) => fakeSnapshot(taskId, approvalMode ? { approvalMode } : {});
  const host = new FakeRuntimeHost();
  const original = host.create.bind(host);
  host.create = (runId, directory) => {
    host.scripts.set(runId, script);
    return original(runId, directory);
  };
  const published: Array<{ taskId: string; owner: string; event: string; payload: Record<string, unknown> }> = [];
  const journal = new DurableRunJournal(join(root, 'journal', 'runs-v2.sqlite'));
  const service = new RunService({
    journal,
    controlPlane: cp,
    runtimes: new Map([['opencode', new FakeRuntime(host)]]),
    publication: new FakePublication(),
    workspace: new FakeWorkspace(join(root, 'worktrees')),
    events: { publish: (taskId, owner, event, payload) => published.push({ taskId, owner, event, payload }) },
    options: { ...TEST_OPTIONS, ...options },
  });
  services.push(service);
  return { cp, host, journal, service, published };
}

async function settled(h: ReturnType<typeof harness>, runId: string): Promise<void> {
  await waitFor(() => {
    const record = h.journal.get(runId);
    return record && isTerminalRunState(record.state) && h.journal.effects(runId).every((effect) => effect.status !== 'pending');
  }, `run ${runId} settled`);
}

function approvalEvents(h: ReturnType<typeof harness>): string[] {
  return h.published.filter((entry) => entry.event === 'approval:changed').map((entry) => `${String(entry.payload.state)}${entry.payload.by ? `:${String(entry.payload.by)}` : ''}`);
}

describe('FE-04 approvals in the run engine', () => {
  it('ask: the request waits for the owner; only the owner sees and answers it, quoting the digest; allow reaches the runner', async () => {
    const h = harness('ask');
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    const [pending] = await waitFor(() => {
      const list = h.service.pendingApprovals('task-1', 'user-1');
      return list.length > 0 ? list : null;
    }, 'pending approval');

    expect(h.host.startPermissions).toEqual(['ask']);
    expect(pending).toMatchObject({ runId: started.runId, taskId: 'task-1', ownerUserId: 'user-1', tool: 'bash', detail: 'rm -rf build', taskTitle: 'Task task-1' });
    expect(h.journal.get(started.runId)?.state).toBe('awaiting_approval');
    expect(h.service.approvalsWaitingOn('user-1').map((approval) => approval.id)).toEqual([pending?.id]);
    // Nobody else sees it or can answer it; a changed operation is refused.
    expect(h.service.pendingApprovals('task-1', 'user-2')).toEqual([]);
    expect(h.service.approvalsWaitingOn('user-2')).toEqual([]);
    const id = pending?.id ?? '';
    const digest = pending?.digest ?? '';
    expect(() => h.service.decideApproval({ taskId: 'task-1', approvalId: id, decision: 'allow', digest, userId: 'user-2' })).toThrow(expect.objectContaining({ statusCode: 403, code: 'APPROVAL_FORBIDDEN' }));
    expect(() => h.service.decideApproval({ taskId: 'task-1', approvalId: id, decision: 'allow', digest: 'f'.repeat(64), userId: 'user-1' })).toThrow(expect.objectContaining({ statusCode: 409, code: 'APPROVAL_CHANGED' }));
    expect(h.host.permissionReplies).toEqual([]);

    expect(h.service.decideApproval({ taskId: 'task-1', approvalId: id, decision: 'allow', digest, userId: 'user-1' })).toMatchObject({ decision: 'allow', by: 'user', userId: 'user-1' });
    // A replay approves nothing.
    expect(() => h.service.decideApproval({ taskId: 'task-1', approvalId: id, decision: 'allow', digest, userId: 'user-1' })).toThrow(expect.objectContaining({ statusCode: 404, code: 'APPROVAL_NOT_FOUND' }));
    await settled(h, started.runId);

    expect(h.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.host.permissionReplies).toEqual([{ sessionId: expect.any(String), id: 'perm-1', decision: 'allow', scope: 'once' }]);
    expect(h.service.pendingApprovals('task-1', 'user-1')).toEqual([]);
    expect(approvalEvents(h)).toEqual(['pending', 'allowed:user']);
    expect(h.published.filter((entry) => entry.event === 'approval:changed').every((entry) => entry.owner === 'user-1' && entry.taskId === 'task-1')).toBe(true);
    const logs = h.service.logsFor('task-1').map((entry) => entry.message);
    expect(logs).toContain('Waiting for your approval: bash');
    expect(logs).toContain('Approved: bash');
    expect(logs.some((message) => message.includes('by policy'))).toBe(false);
  });

  it('ask: "allow for this run" — later requests for that tool in the run are allowed without asking', async () => {
    const h = harness('ask', {}, [
        { t: 'turn.started', turn: 1 },
        { t: 'permission.requested', id: 'perm-1', tool: 'bash', detail: 'pnpm test' },
        { hold: 'reply:perm-1' },
        { t: 'permission.requested', id: 'perm-2', tool: 'bash', detail: 'pnpm lint' },
        { hold: 'reply:perm-2' },
        { t: 'permission.requested', id: 'perm-3', tool: 'edit', detail: 'src/a.ts' },
        { hold: 'reply:perm-3' },
        { writeFile: 'change.txt' },
        { t: 'file.changed', path: 'change.txt', kind: 'create' },
        { t: 'turn.finished', turn: 1, reason: 'idle' },
    ]);
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    const waiting = async (tool: string) => {
      const [approval] = await waitFor(() => {
        const list = h.service.pendingApprovals('task-1', 'user-1').filter((entry) => entry.tool === tool);
        return list.length > 0 ? list : null;
      }, `pending ${tool}`);
      return approval;
    };
    const bash = await waiting('bash');
    expect(h.service.decideApproval({ taskId: 'task-1', approvalId: bash?.id ?? '', decision: 'allow', scope: 'run', digest: bash?.digest ?? '', userId: 'user-1' })).toMatchObject({ decision: 'allow', scope: 'run' });
    // Another tool is still asked.
    const edit = await waiting('edit');
    h.service.decideApproval({ taskId: 'task-1', approvalId: edit?.id ?? '', decision: 'allow', digest: edit?.digest ?? '', userId: 'user-1' });
    await settled(h, started.runId);

    expect(h.journal.get(started.runId)?.state).toBe('succeeded');
    // The runner is answered once each time; the run remembers the tool (no runner-side session grant to outlive the run).
    expect(h.host.permissionReplies.map((reply) => `${reply.id}:${reply.decision}:${reply.scope}`)).toEqual(['perm-1:allow:once', 'perm-2:allow:once', 'perm-3:allow:once']);
    expect(approvalEvents(h)).toEqual(['pending', 'allowed:user', 'pending', 'allowed:user']);
    const logs = h.service.logsFor('task-1').map((entry) => entry.message);
    expect(logs).toContain('Approved for the rest of this run: bash');
    expect(logs).toContain('Allowed (you allowed bash for this run)');
    // A deny is never widened to the run.
    expect(h.service.pendingApprovals('task-1', 'user-1')).toEqual([]);
  });

  it('ask (review fix): a request the agent withdraws leaves every view, gets no reply, and the run carries on', async () => {
    const h = harness('ask');
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    const [pending] = await waitFor(() => {
      const list = h.service.pendingApprovals('task-1', 'user-1');
      return list.length > 0 ? list : null;
    }, 'pending approval');
    h.host.withdrawPermission('perm-1');
    await settled(h, started.runId);

    expect(h.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.host.permissionReplies).toEqual([]);
    expect(h.service.pendingApprovals('task-1', 'user-1')).toEqual([]);
    expect(approvalEvents(h)).toEqual(['pending', 'denied:withdrawn']);
    expect(h.service.logsFor('task-1').map((entry) => entry.message)).toContain('Withdrawn by the agent (no answer needed): bash');
    expect(() => h.service.decideApproval({ taskId: 'task-1', approvalId: pending?.id ?? '', decision: 'allow', digest: pending?.digest ?? '', userId: 'user-1' }))
      .toThrow(expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' }));
  });

  it('ask: a deny reaches the runner and the run carries on', async () => {
    const h = harness('ask');
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    const [pending] = await waitFor(() => {
      const list = h.service.pendingApprovals('task-1', 'user-1');
      return list.length > 0 ? list : null;
    }, 'pending approval');
    h.service.decideApproval({ taskId: 'task-1', approvalId: pending?.id ?? '', decision: 'deny', digest: pending?.digest ?? '', userId: 'user-1' });
    await settled(h, started.runId);

    expect(h.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.host.permissionReplies.map((reply) => reply.decision)).toEqual(['deny']);
    expect(approvalEvents(h)).toEqual(['pending', 'denied:user']);
    expect(h.service.logsFor('task-1').map((entry) => entry.message)).toContain('Denied: bash');
  });

  it('ask: no answer in time is a deny (the run is not failed)', async () => {
    const h = harness('ask', { approvalTimeoutMs: 40 });
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    await settled(h, started.runId);

    expect(h.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.host.permissionReplies.map((reply) => reply.decision)).toEqual(['deny']);
    expect(approvalEvents(h)).toEqual(['pending', 'denied:timeout']);
    expect(h.service.logsFor('task-1').map((entry) => entry.message)).toContain('Denied (no answer in time): bash');
  });

  it('ask: cancelling while a request waits denies it and stops the run without answering the runner', async () => {
    const h = harness('ask');
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    const [pending] = await waitFor(() => {
      const list = h.service.pendingApprovals('task-1', 'user-1');
      return list.length > 0 ? list : null;
    }, 'pending approval');
    const cancelled = await h.service.cancel('task-1', 'user cancelled');
    await settled(h, started.runId);

    expect(cancelled.success).toBe(true);
    expect(h.journal.get(started.runId)?.state).toBe('cancelled');
    expect(h.host.permissionReplies).toEqual([]);
    expect(approvalEvents(h)).toEqual(['pending', 'denied:cancel']);
    expect(() => h.service.decideApproval({ taskId: 'task-1', approvalId: pending?.id ?? '', decision: 'allow', digest: pending?.digest ?? '', userId: 'user-1' }))
      .toThrow(expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' }));
  });

  it('FE-03: an ended trust grant cancels the active runs it let start (unknown and finished runs are skipped)', async () => {
    const h = harness('ask');
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    await waitFor(() => h.service.pendingApprovals('task-1', 'user-1').length > 0, 'pending approval');
    expect(h.service.cancelRuns([started.runId, started.runId, 'run-unknown'], 'trust grant ended')).toEqual([started.runId]);
    await settled(h, started.runId);
    expect(h.journal.get(started.runId)).toMatchObject({ state: 'cancelled', cancelReason: 'trust grant ended' });
    expect(h.service.cancelRuns([started.runId], 'trust grant ended')).toEqual([]);
  });

  it('auto (and an unsealed mode) answer by policy at once, as before', async () => {
    for (const mode of ['auto', undefined] as const) {
      const h = harness(mode);
      h.cp.addTask('task-1');
      const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
      await settled(h, started.runId);

      expect(h.journal.get(started.runId)?.state).toBe('succeeded');
      expect(h.host.startPermissions).toEqual(['allow']);
      expect(h.host.permissionReplies.map((reply) => reply.decision)).toEqual(['allow']);
      expect(approvalEvents(h)).toEqual([]);
      expect(h.service.logsFor('task-1').map((entry) => entry.message)).toContain('Permission granted by policy: bash');
    }
  });

  it('ask on a policy-only runner: started with the policy, and the log says the runner cannot pause', async () => {
    const h = harness('ask');
    h.host.approvals = 'policy-only';
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential('user-1'), taskId: 'task-1' });
    await settled(h, started.runId);

    expect(h.host.startPermissions).toEqual(['allow']);
    expect(h.host.permissionReplies.map((reply) => reply.decision)).toEqual(['allow']);
    expect(approvalEvents(h)).toEqual([]);
    expect(h.service.logsFor('task-1').map((entry) => entry.message)).toContain('opencode cannot pause for your approval; it runs under the sandbox policy instead');
  });

  it('seals "ask" from the execution settings into the run snapshot', () => {
    const task = { id: 't', title: 'T', description: null, model: null, agent: null, teamId: 'tm', creatorId: null, workspaceId: null, projectId: null, project: null, labels: [] };
    const settings = { parallelLimit: 3, maxBatchSize: 3, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'skip' as const };
    expect(snapshotFromTask(task, null, { ...settings, approvalMode: 'ask' }).approvalMode).toBe('ask');
    expect(snapshotFromTask(task, null, { ...settings, approvalMode: 'auto' })).not.toHaveProperty('approvalMode');
    expect(snapshotFromTask(task, null, settings)).not.toHaveProperty('approvalMode');
  });
});
