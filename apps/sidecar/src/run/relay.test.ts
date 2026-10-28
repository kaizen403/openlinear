import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { isTerminalRunState } from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import { RunService } from './service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeWorkspace, fakeCredential } from './test-support';

/**
 * Regression found by the W07a soak: a relay flush that found nothing to send
 * returned synchronously, so its `finally` cleared `inFlight` BEFORE the
 * caller stored the (already settled) promise there. The run's relay then
 * looked busy forever: nothing more was delivered to the control plane, and
 * after the close the undelivered events were acknowledged locally. Queued
 * runs hit it every time (their first flush only sees `run.accepted`).
 */

const roots: string[] = [];
const services: RunService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('delivers every relayable event of a run that waited in the queue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ol-relay-'));
  roots.push(root);
  const cp = new FakeControlPlane();
  cp.parallelLimit = 1;
  const host = new FakeRuntimeHost();
  const journal = new DurableRunJournal(join(root, 'journal.sqlite'));
  const service = new RunService({
    journal,
    controlPlane: cp,
    runtimes: new Map([['opencode', new FakeRuntime(host)]]),
    publication: new FakePublication(),
    workspace: new FakeWorkspace(join(root, 'worktrees')),
    options: {
      heartbeatMs: 3_600_000,
      relayDelayMs: 20,
      retryBaseMs: 5,
      retryMaxMs: 20,
      relayRetryBaseMs: 5,
      relayRetryMaxMs: 20,
      interruptGraceMs: 0,
      watchdogIntervalMs: 20,
      watchdog: { transportMs: 1e9, noProgressMs: 1e9, wallClockMs: 1e9 },
    },
  });
  services.push(service);
  cp.addTask('task-1');
  cp.addTask('task-2');
  const original = host.create.bind(host);
  let created = 0;
  host.create = (id, directory) => {
    created += 1;
    if (created === 1) host.scripts.set(id, [{ t: 'turn.started', turn: 1 }, { hold: 'go' }, { writeFile: 'a.txt' }, { t: 'turn.finished', turn: 1, reason: 'idle' }]);
    return original(id, directory);
  };
  const first = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
  const queued = await service.submit({ credential: fakeCredential(), taskId: 'task-2' });
  expect(queued.state).toBe('queued');
  // Long enough for the queued run's first (empty) flush to happen.
  await new Promise((resolve) => setTimeout(resolve, 100));
  [...host.sessions.values()][0]?.release('go');
  const deadline = Date.now() + 5_000;
  for (;;) {
    const done = [first.runId, queued.runId].every((runId) => {
      const record = journal.get(runId);
      return record && isTerminalRunState(record.state) && journal.effects(runId).every((effect) => effect.status !== 'pending');
    });
    if (done) break;
    if (Date.now() > deadline) throw new Error('runs did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  for (const run of [first, queued]) {
    const relayable = journal.events(run.runId, 0, 10_000).filter((event) => event.relay).map((event) => event.seq);
    const delivered = cp.delivered.filter((event) => event.attemptId === run.attemptId).map((event) => event.seq);
    expect(delivered, run.runId).toEqual(relayable);
    expect(journal.get(run.runId)?.relayAckSeq).toBe(relayable.at(-1));
  }
  expect(journal.get(queued.runId)?.state).toBe('succeeded');
});
