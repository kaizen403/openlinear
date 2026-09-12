import { describe, expect, it } from 'vitest';
import { RunJournal } from '../../journal/sqlite';
import { recoverActiveBatches, recoverInFlightExecutions } from './recovery';
import { FakeAgentRunner } from '@openlinear/execution-core';

describe('execution recovery', () => {
  it('returns zero recovery work when the journal is empty', async () => {
    const journal = new RunJournal(':memory:');
    await expect(recoverInFlightExecutions({ journal })).resolves.toEqual({
      recovered: 0,
      orphaned: 0,
      resumed: 0,
      salvaged: 0,
      failed: 0,
    });
    journal.close();
  });

  it('FAIL when the runner session is gone', async () => {
    const journal = new RunJournal(':memory:');
    journal.startRun({
      id: 'run-1',
      taskId: 'task-1',
      batchId: null,
      runner: 'opencode',
      externalSessionId: 'missing',
      worktreePath: null,
      status: 'running',
      budgetsJson: '{}',
      usageJson: null,
    });
    const result = await recoverInFlightExecutions({
      journal,
      runner: null,
      hasDiff: async () => false,
    });
    expect(result.failed).toBe(1);
    expect(journal.getRun('run-1')?.status).toBe('failed');
    journal.close();
  });

  it('RESUME a fresh busy runner session', async () => {
    const journal = new RunJournal(':memory:');
    journal.startRun({
      id: 'run-2',
      taskId: 'task-2',
      batchId: null,
      runner: 'opencode',
      externalSessionId: 'ses_2',
      worktreePath: '/tmp/wt',
      status: 'running',
      budgetsJson: '{}',
      usageJson: null,
    });
    const runner = new FakeAgentRunner();
    const result = await recoverInFlightExecutions({
      journal,
      runner,
      hasDiff: async () => false,
    });
    expect(result.resumed).toBe(1);
    journal.close();
  });

  it('SALVAGE a stale idle run with a diff', async () => {
    const journal = new RunJournal(':memory:');
    journal.startRun({
      id: 'run-3',
      taskId: 'task-3',
      batchId: null,
      runner: 'opencode',
      externalSessionId: 'ses_3',
      worktreePath: '/tmp/wt',
      status: 'running',
      budgetsJson: '{}',
      usageJson: null,
    });
    const result = await recoverInFlightExecutions({
      journal,
      now: Date.now() + 5 * 60 * 1000,
      runner: new FakeAgentRunner(),
      hasDiff: async () => true,
    });
    expect(result.salvaged).toBe(1);
    journal.close();
  });

  it('reports no stale batches from the journal helper', async () => {
    await expect(recoverActiveBatches()).resolves.toMatchObject({ recovered: 0, orphaned: 0 });
  });
});
