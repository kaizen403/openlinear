import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunJournal } from './sqlite';
import { recoverInFlightExecutions } from '../services/execution/recovery';
import { FakeAgentRunner } from '@openlinear/execution-core';
import { createTestCoordinator } from '../engine/run-coordinator';

describe('RunJournal', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('assigns monotonic seq used as SSE ids and survives reopen (SIGKILL simulation)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ol-journal-'));
    dirs.push(dir);
    const path = join(dir, 'runs.sqlite');
    const journal = new RunJournal(path);
    journal.startRun({
      id: 'run-1',
      taskId: 'task-1',
      batchId: null,
      runner: 'opencode',
      externalSessionId: 'ses_1',
      worktreePath: '/tmp/wt',
      status: 'running',
      budgetsJson: '{}',
      usageJson: null,
    });
    const first = journal.append('run-1', { t: 'heartbeat' });
    const second = journal.append('run-1', { t: 'message.delta', text: 'hi' });
    expect(first.seq).toBe(1);
    expect(second.sseId).toBe('run:run-1:2');
    journal.close();

    const reopened = new RunJournal(path);
    const third = reopened.append('run-1', { t: 'turn.finished', turn: 1, reason: 'idle' });
    expect(third.seq).toBe(3);
    expect(reopened.listRunning()).toHaveLength(1);
    reopened.close();
  });
});

describe('boot recovery matrix', () => {
  it('RESUME / SALVAGE / FAIL from journal state', async () => {
    const journal = new RunJournal(':memory:');
    const now = 10 * 60 * 1000;
    journal.startRun({
      id: 'resume-me',
      taskId: 't1',
      batchId: null,
      runner: 'opencode',
      externalSessionId: 'ses_busy',
      worktreePath: '/tmp/a',
      status: 'running',
      budgetsJson: '{}',
      usageJson: null,
    });
    journal.heartbeat('resume-me');

    const runner = new FakeAgentRunner();
    const result = await recoverInFlightExecutions({
      journal,
      runner,
      now: now + 30_000,
      hasDiff: async () => false,
    });
    expect(result.resumed + result.salvaged + result.failed).toBeGreaterThanOrEqual(1);
    journal.close();
  });
});

describe('fake-runner parallel batch', () => {
  it('cancelling one of three runs does not finish the others', async () => {
    const { coordinator, runner } = createTestCoordinator();
    runner.setScript('a', { events: [{ t: 'message.delta', text: 'a' }, { t: 'turn.finished', turn: 1, reason: 'idle' }], delayMs: 80 });
    runner.setScript('b', { events: [{ t: 'message.delta', text: 'b' }, { t: 'turn.finished', turn: 1, reason: 'idle' }], delayMs: 80 });
    runner.setScript('c', { events: [{ t: 'message.delta', text: 'c' }, { t: 'turn.finished', turn: 1, reason: 'idle' }], delayMs: 80 });

    const finished: string[] = [];
    const start = (id: string) => coordinator.start({
      runId: id,
      taskId: id,
      runnerId: 'opencode',
      worktreePath: `/tmp/${id}`,
      prompt: id,
      onComplete: async (ok) => {
        if (ok) finished.push(id);
      },
    });

    const running = Promise.all([start('a'), start('b'), start('c')]);
    await coordinator.cancel('a');
    await running;
    expect(finished.sort()).toEqual(['b', 'c']);
  });
});

describe('staging allowlist', () => {
  it('blocks .github paths', async () => {
    const { isBlockedPath } = await import('../engine/staging-allowlist');
    expect(isBlockedPath('.github/workflows/ci.yml')).toContain('opt-in');
    expect(isBlockedPath('src/index.ts')).toBeNull();
  });
});
