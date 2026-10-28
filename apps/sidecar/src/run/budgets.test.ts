import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionTaskSnapshot } from '@openlinear/api-client';
import { isTerminalRunState } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import { snapshotFromTask } from './control-plane';
import { RunService, type RunServiceOptions } from './service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeWorkspace, fakeCredential, fakeSnapshot, type HostStep } from './test-support';

/**
 * W15a: per-run budgets. The user's cost / token limits travel with the
 * attempt snapshot, are journaled with the run, and stop an agent that
 * reaches them — the work is kept and the outcome names the budget.
 */

const roots: string[] = [];
const services: RunService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
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
  watchdogIntervalMs: 10,
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

const SPENDING: HostStep[] = [
  { t: 'turn.started', turn: 1 },
  { writeFile: 'work.txt' },
  { t: 'file.changed', path: 'work.txt', kind: 'create' },
  { t: 'usage', usage: { input: 4_000, output: 2_000, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 0.75 }, messageId: 'm1' },
  { hold: 'never' },
];

function boot(budgets: { maxUsd?: number; maxTokens?: number } | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'ol-budgets-'));
  roots.push(root);
  const cp = new FakeControlPlane();
  cp.addTask('task-1');
  cp.snapshot = (taskId) => fakeSnapshot(taskId, budgets ? { budgets } : {});
  const host = new FakeRuntimeHost();
  const original = host.create.bind(host);
  host.create = (id, directory) => {
    host.scripts.set(id, SPENDING);
    return original(id, directory);
  };
  const publication = new FakePublication();
  const workspace = new FakeWorkspace(join(root, 'worktrees'));
  const journal = new DurableRunJournal(join(root, 'journal', 'runs-v2.sqlite'));
  const service = new RunService({ journal, controlPlane: cp, runtimes: new Map([['opencode', new FakeRuntime(host)]]), publication, workspace, options: OPTIONS });
  services.push(service);
  return { cp, journal, service, publication, workspace };
}

async function settle(h: ReturnType<typeof boot>, runId: string) {
  await waitFor(() => {
    const record = h.journal.get(runId);
    return record && isTerminalRunState(record.state) && h.journal.effects(runId).every((effect) => effect.status !== 'pending') ? record : null;
  }, 'run settled');
}

describe('W15a per-run budgets', () => {
  it('stops a run that reaches its cost budget; the work is kept and nothing is published', async () => {
    const h = boot({ maxUsd: 0.5 });
    const started = await h.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    expect(h.journal.get(started.runId)?.snapshot.budgets).toEqual({ maxUsd: 0.5 });
    await settle(h, started.runId);
    const record = h.journal.get(started.runId);
    expect(record?.state).toBe('failed');
    expect(record?.terminal?.outcome ?? '').toContain("reached this run's cost budget ($0.75 of $0.50)");
    expect(h.publication.pushCalls).toBe(0);
    expect(h.workspace.released).toEqual([]);
    expect(h.cp.tasks.get('task-1')?.outcome ?? '').toContain('cost budget');
    expect(h.service.describe('task-1')?.budgets).toEqual({ maxUsd: 0.5 });
  });

  it('stops at the token budget (input + output)', async () => {
    const h = boot({ maxTokens: 5_000 });
    const started = await h.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settle(h, started.runId);
    expect(h.journal.get(started.runId)?.terminal?.outcome ?? '').toContain("token budget (6,000 of 5,000 tokens)");
  });

  it('without budgets the same spend does not stop the run', async () => {
    const h = boot(undefined);
    const started = await h.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => h.journal.get(started.runId)?.usage ? true : null, 'usage recorded');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(h.journal.get(started.runId)?.state).toBe('running');
  });
});

describe('W15a budgets in the attempt snapshot', () => {
  const task: ExecutionTaskSnapshot = { id: 't', title: 'T', description: null, model: null, agent: null, labels: [], projectId: null, teamId: 'tm', creatorId: null, workspaceId: null, project: null };

  it('seals positive limits and ignores absent or invalid ones', () => {
    const base = { parallelLimit: 2, maxBatchSize: 3, queueAutoApprove: false, stopOnFailure: false, conflictBehavior: 'skip' as const };
    expect(snapshotFromTask(task, null, { ...base, maxRunCostUsd: 2.5, maxRunTokens: 200_000 }).budgets).toEqual({ maxUsd: 2.5, maxTokens: 200_000 });
    expect(snapshotFromTask(task, null, { ...base, maxRunCostUsd: null, maxRunTokens: 50_000 }).budgets).toEqual({ maxTokens: 50_000 });
    expect(snapshotFromTask(task, null, { ...base, maxRunCostUsd: 0, maxRunTokens: null }).budgets).toBeUndefined();
    expect(snapshotFromTask(task, null, base).budgets).toBeUndefined();
  });
});
