import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RunTransitionError, runEffectKey } from '@openlinear/execution-core';
import { DurableRunJournal, JournalCorruptError, MAX_EVENTS_PER_RUN, type NewRun } from './durable';
import { fakeSnapshot } from '../run/test-support';

const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR_ROOT = resolve(HERE, '../..');
const dirs: string[] = [];
const open: DurableRunJournal[] = [];

afterEach(() => {
  for (const journal of open.splice(0)) journal.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ol-durable-'));
  dirs.push(dir);
  return join(dir, 'journal', 'runs-v2.sqlite');
}

function journalAt(path: string): DurableRunJournal {
  const journal = new DurableRunJournal(path);
  open.push(journal);
  return journal;
}

function newRun(runId = 'run-1'): NewRun {
  return {
    runId,
    taskId: 'task-1',
    userId: 'user-1',
    attemptId: 'attempt-1',
    capability: 'olx_secret',
    capabilityExpiresAt: Date.now() + 60_000,
    runner: 'opencode',
    model: 'fake/model',
    state: 'preparing',
    snapshot: fakeSnapshot('task-1'),
    bootId: 'boot-1',
  };
}

describe('DurableRunJournal', () => {
  it('creates a private file and records acceptance atomically with its first event', () => {
    const path = tempPath();
    const journal = journalAt(path);
    const record = journal.createRun(newRun(), { attemptId: 'attempt-1' });
    expect(record).toMatchObject({ state: 'preparing', stateVersion: 1, lastSeq: 1, relayAckSeq: 0 });
    expect(journal.events('run-1')[0]).toMatchObject({ seq: 1, kind: 'run.accepted', relay: false });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
  });

  it('transitions with compare-and-set, the state event and effect intents in one transaction', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun(), {});
    const result = journal.transition('run-1', {
      from: 'preparing',
      to: 'running',
      reason: 'claimed',
      effects: [{ key: runEffectKey('run-1', 'prompt.submit'), kind: 'prompt.submit', intent: { sessionId: 'ses_1' } }],
      patch: { sessionId: 'ses_1' },
    });
    expect(result.record).toMatchObject({ state: 'running', stateVersion: 2, sessionId: 'ses_1' });
    expect(journal.effect('run-1', 'run-1:prompt.submit')).toMatchObject({ status: 'pending', dispatches: 0 });
    expect(journal.events('run-1').map((event) => event.kind)).toEqual(['run.accepted', 'run.state', 'effect']);

    expect(() => journal.transition('run-1', { from: 'preparing', to: 'running', reason: 'stale' })).toThrow(RunTransitionError);
    expect(() => journal.transition('run-1', { from: 'running', to: 'queued', reason: 'illegal' })).toThrow(RunTransitionError);
    expect(() => journal.transition('run-1', { from: 'running', to: 'failed', reason: 'no decision' })).toThrow('terminal decision');
  });

  it('rolls back the whole transition when any part fails (no state change, no event, no effect)', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun(), {});
    journal.recordEffect('run-1', { key: 'run-1:git.commit', kind: 'git.commit', intent: {} });
    const before = journal.get('run-1');
    expect(() => journal.transition('run-1', {
      from: 'preparing',
      to: 'running',
      reason: 'conflicting effect key',
      effects: [
        { key: 'run-1:prompt.submit', kind: 'prompt.submit', intent: {} },
        { key: 'run-1:git.commit', kind: 'git.push', intent: {} },
      ],
    })).toThrow('already names');
    expect(journal.get('run-1')).toEqual(before);
    expect(journal.effect('run-1', 'run-1:prompt.submit')).toBeNull();
  });

  it('allows exactly one terminal decision', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun(), {});
    const terminal = { state: 'failed' as const, reason: 'x', outcome: null, prUrl: null, claimed: false };
    journal.transition('run-1', { from: ['preparing'], to: 'failed', reason: 'x', terminal });
    expect(journal.get('run-1')?.finishedAt).not.toBeNull();
    expect(() => journal.transition('run-1', { from: ['failed'], to: 'cancelled', reason: 'y', terminal: { ...terminal, state: 'cancelled' } })).toThrow(RunTransitionError);
  });

  it('keeps events immutable and gap-free', () => {
    const path = tempPath();
    const journal = journalAt(path);
    journal.createRun(newRun(), {});
    for (let index = 0; index < 5; index += 1) journal.append('run-1', { kind: 'log', payload: { n: index }, relay: true });
    const db = new DatabaseSync(path);
    try {
      expect(() => db.exec("UPDATE run_attempt_events SET payload_json = '{}' WHERE run_id = 'run-1'")).toThrow('immutable');
    } finally {
      db.close();
    }
    expect(journal.events('run-1').map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('settles an effect once; a second receipt does not overwrite the first', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun(), {});
    journal.recordEffect('run-1', { key: 'k', kind: 'git.commit', intent: { branch: 'b' } });
    journal.markDispatched('run-1', 'k');
    const first = journal.settleEffect('run-1', 'k', 'confirmed', { sha: 'abc' });
    const second = journal.settleEffect('run-1', 'k', 'failed', { sha: 'zzz' });
    expect(first).toMatchObject({ status: 'confirmed', receipt: { sha: 'abc' }, dispatches: 1 });
    expect(second).toEqual(first);
    expect(journal.recordEffect('run-1', { key: 'k', kind: 'git.commit', intent: {} })).toEqual(first);
    expect(() => journal.settleEffect('run-1', 'missing', 'confirmed', {})).toThrow(JournalCorruptError);
    expect(journal.latestEffect('run-1', 'git.commit')?.key).toBe('k');
  });

  it('persists the acknowledged relay cursor monotonically and lists unrelayed events from it', () => {
    const path = tempPath();
    const journal = journalAt(path);
    journal.createRun(newRun(), {});
    for (let index = 0; index < 60; index += 1) journal.append('run-1', { kind: 'log', payload: { n: index }, relay: true });
    journal.append('run-1', { kind: 'agent', payload: { t: 'tool.started' } });
    expect(journal.unrelayed('run-1')).toHaveLength(50);
    expect(journal.ackRelay('run-1', 30)).toBe(30);
    expect(journal.ackRelay('run-1', 10)).toBe(30);
    journal.close();
    const reopened = journalAt(path);
    expect(reopened.get('run-1')?.relayAckSeq).toBe(30);
    const rest = reopened.unrelayed('run-1', 100);
    expect(rest[0]?.seq).toBe(31);
    expect(rest.at(-1)?.seq).toBe(61);
    expect(rest.every((event) => event.relay)).toBe(true);
  });

  it('survives SIGKILL: every committed write of a killed process is there after reopen', () => {
    const path = tempPath();
    const script = join(dirname(path), '..', 'writer.ts');
    writeFileSync(script, `
      import { DurableRunJournal } from ${JSON.stringify(join(SIDECAR_ROOT, 'src/journal/durable.ts'))};
      import { fakeSnapshot } from ${JSON.stringify(join(SIDECAR_ROOT, 'src/run/test-support.ts'))};
      const journal = new DurableRunJournal(${JSON.stringify(path)});
      journal.createRun({ runId: 'run-k', taskId: 't', userId: 'u', attemptId: 'a', capability: 'olx_x', capabilityExpiresAt: 1, runner: 'opencode', model: null, state: 'preparing', snapshot: fakeSnapshot('t'), bootId: 'b' }, {});
      for (let i = 0; i < 200; i += 1) journal.append('run-k', { kind: 'log', payload: { i }, relay: true });
      journal.ackRelay('run-k', 120);
      journal.recordEffect('run-k', { key: 'run-k:git.commit', kind: 'git.commit', intent: {} });
      process.kill(process.pid, 'SIGKILL');
    `);
    const result = spawnSync(process.execPath, ['--import', 'tsx', script], { cwd: SIDECAR_ROOT, encoding: 'utf8' });
    expect(result.signal).toBe('SIGKILL');
    const journal = journalAt(path);
    const record = journal.get('run-k');
    // 1 acceptance + 200 logs + 1 effect-intent event.
    expect(record).toMatchObject({ lastSeq: 202, relayAckSeq: 120 });
    expect(journal.events('run-k', 0, 1_000).map((event) => event.seq)).toEqual(Array.from({ length: 202 }, (_, index) => index + 1));
    expect(journal.effect('run-k', 'run-k:git.commit')?.status).toBe('pending');
    // Logs are seq 2..201; everything after the acknowledged 120 is replayed.
    expect(journal.unrelayed('run-k', 200).map((event) => event.seq)).toEqual(Array.from({ length: 81 }, (_, index) => index + 121));
    expect(journal.listRecoverable().map((run) => run.runId)).toContain('run-k');
  }, 60_000);

  it('bounds events per run but always keeps critical ones', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun(), {});
    const db = new DatabaseSync(journal.path);
    try {
      db.exec(`UPDATE run_attempts SET last_seq = ${MAX_EVENTS_PER_RUN} WHERE run_id = 'run-1'`);
    } finally {
      db.close();
    }
    expect(journal.append('run-1', { kind: 'agent', payload: {} })).toBeNull();
    expect(journal.get('run-1')?.counters.droppedEvents).toBe(1);
    expect(journal.append('run-1', { kind: 'log', payload: {}, critical: true })).toBe(MAX_EVENTS_PER_RUN + 1);
  });

  it('truncates oversized payloads into valid JSON', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun(), {});
    journal.append('run-1', { kind: 'agent', payload: { big: 'x'.repeat(100_000) } });
    const event = journal.events('run-1').at(-1);
    expect(event?.payload).toMatchObject({ truncated: true });
  });

  it('lists recoverable runs and prunes only finished runs with nothing pending', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun('run-live'), {});
    journal.createRun(newRun('run-done'), {});
    journal.createRun(newRun('run-pending'), {});
    const terminal = { state: 'failed' as const, reason: 'x', outcome: null, prUrl: null, claimed: false };
    journal.transition('run-done', { from: 'preparing', to: 'failed', reason: 'x', terminal });
    journal.transition('run-pending', { from: 'preparing', to: 'failed', reason: 'x', terminal, effects: [{ key: 'run-pending:attempt.close', kind: 'attempt.close', intent: {} }] });
    journal.ackRelay('run-done', 99);
    expect(journal.listRecoverable().map((run) => run.runId).sort()).toEqual(['run-live', 'run-pending']);
    expect(journal.pruneFinished(0, Date.now() + 1_000)).toBe(1);
    expect(journal.get('run-done')).toBeNull();
    expect(journal.get('run-pending')).not.toBeNull();
    expect(journal.latestForTask('task-1')?.runId).toBeDefined();
  });

  it('reports a corrupted row instead of driving an effect from it', () => {
    const journal = journalAt(tempPath());
    journal.createRun(newRun(), {});
    const db = new DatabaseSync(journal.path);
    try {
      db.exec(`UPDATE run_attempts SET snapshot_json = '{"title":1}' WHERE run_id = 'run-1'`);
    } finally {
      db.close();
    }
    expect(() => journal.get('run-1')).toThrow(JournalCorruptError);
  });

  it('lets one live process own the journal; a dead owner is replaced', () => {
    const path = tempPath();
    const first = journalAt(path);
    expect(first.claimOwnership({ pid: 111, bootId: 'a' }, () => true)).toEqual({ ok: true });
    const second = journalAt(path);
    expect(second.claimOwnership({ pid: 222, bootId: 'b' }, (pid) => pid === 111)).toEqual({ ok: false, pid: 111 });
    expect(second.claimOwnership({ pid: 222, bootId: 'b' }, () => false)).toEqual({ ok: true });
    expect(first.claimOwnership({ pid: 222, bootId: 'c' }, () => true)).toEqual({ ok: true });
  });

  it('defaults to runs-v2.sqlite in the app data root', () => {
    expect(DurableRunJournal.defaultPath({ OPENLINEAR_APP_DATA: '/tmp/ol-app' })).toBe('/tmp/ol-app/journal/runs-v2.sqlite');
  });
});
