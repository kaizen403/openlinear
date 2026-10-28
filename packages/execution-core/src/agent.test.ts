import { describe, expect, it } from 'vitest';
import { addTokenUsage, emptyTokenUsage, executionSseId, parseExecutionSseId } from './agent';
import { admitRun, decideRecovery } from './coordinator';
import { FakeAgentRunner } from './fake-runner';
import { processAgentEvent, type EventProcessorState } from './process-agent-event';

function state(overrides: Partial<EventProcessorState> = {}): EventProcessorState {
  return {
    taskId: 't1',
    sessionId: 's1',
    promptSent: true,
    cancelled: false,
    status: 'executing',
    backgroundTaskRunning: false,
    backgroundTaskFailure: null,
    completedToolKeys: new Set(),
    toolsExecuted: 0,
    filesChanged: 0,
    suspendWatchdogs: false,
    ...overrides,
  };
}

describe('processAgentEvent', () => {
  it('completes an idle turn independently of other runs', () => {
    const actions = processAgentEvent({ t: 'turn.finished', turn: 1, reason: 'idle' }, state());
    expect(actions.map((a) => a.type)).toContain('handleSessionComplete');
  });

  it('W12a: a turn that hit the turn limit is not success — it fails with the work kept', () => {
    const actions = processAgentEvent({ t: 'turn.finished', turn: 3, reason: 'max_turns' }, state());
    expect(actions.map((a) => a.type)).toEqual(['flushDeltaBuffer', 'failExecution']);
    expect(actions.map((a) => a.type)).not.toContain('handleSessionComplete');
    expect(actions[1]).toMatchObject({ message: 'The agent stopped at its turn limit before finishing', details: expect.stringContaining('follow-up') });
  });

  it('ignores completion when cancelled', () => {
    const actions = processAgentEvent(
      { t: 'turn.finished', turn: 1, reason: 'idle' },
      state({ cancelled: true }),
    );
    expect(actions).toEqual([{ type: 'ignore' }]);
  });

  it('suspends watchdogs on permission and compaction start', () => {
    expect(
      processAgentEvent(
        { t: 'permission.requested', id: 'p1', tool: 'bash', detail: 'rm' },
        state(),
      ).some((a) => a.type === 'suspendWatchdog'),
    ).toBe(true);
    expect(
      processAgentEvent({ t: 'compaction', phase: 'start' }, state()).some((a) => a.type === 'suspendWatchdog'),
    ).toBe(true);
  });
});

describe('recovery matrix', () => {
  const now = 10 * 60 * 1000;
  it('resumes a fresh busy run', () => {
    expect(
      decideRecovery({
        status: 'running',
        heartbeatAt: now - 30_000,
        now,
        runnerFound: true,
        runnerBusy: true,
        hasDiff: false,
      }),
    ).toBe('RESUME');
  });
  it('salvages a stale idle run with a diff', () => {
    expect(
      decideRecovery({
        status: 'running',
        heartbeatAt: now - 5 * 60 * 1000,
        now,
        runnerFound: true,
        runnerBusy: false,
        hasDiff: true,
      }),
    ).toBe('SALVAGE');
  });
  it('fails when the runner session is gone', () => {
    expect(
      decideRecovery({
        status: 'running',
        heartbeatAt: now - 1000,
        now,
        runnerFound: false,
        runnerBusy: false,
        hasDiff: false,
      }),
    ).toBe('FAIL');
  });
  it('re-runs completion when status is completing', () => {
    expect(
      decideRecovery({
        status: 'completing',
        heartbeatAt: now,
        now,
        runnerFound: false,
        runnerBusy: false,
        hasDiff: true,
      }),
    ).toBe('COMPLETE_IDEMPOTENT');
  });
});

describe('admission', () => {
  it('queues when at the run cap', () => {
    expect(
      admitRun({
        liveRuns: 2,
        liveBatches: 0,
        liveWorktrees: 0,
        maxRuns: 2,
        maxBatches: 4,
        maxWorktrees: 8,
        isBatch: false,
      }),
    ).toEqual({ admitted: false, queued: true });
  });
});

describe('sse ids and usage', () => {
  it('round-trips run seq ids', () => {
    const id = executionSseId('abc', 12);
    expect(id).toBe('run:abc:12');
    expect(parseExecutionSseId(id)).toEqual({ runId: 'abc', seq: 12 });
    expect(parseExecutionSseId('99')).toBeNull();
  });
  it('adds token usage fields', () => {
    const sum = addTokenUsage(emptyTokenUsage(), {
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      reasoning: 5,
    });
    expect(sum).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 });
  });
});

describe('FakeAgentRunner', () => {
  it('cancelling one session does not emit another session idle', async () => {
    const runner = new FakeAgentRunner();
    runner.setScript('a', {
      events: [
        { t: 'message.delta', text: 'a' },
        { t: 'turn.finished', turn: 1, reason: 'idle' },
      ],
    });
    runner.setScript('b', {
      events: [
        { t: 'message.delta', text: 'b' },
        { t: 'turn.finished', turn: 1, reason: 'idle' },
      ],
    });
    const acA = new AbortController();
    const sessionA = await runner.start({
      runId: 'a',
      worktreePath: '/tmp/a',
      systemContract: '',
      prompt: 'a',
      budgets: { wallClockMs: 60_000 },
      permissions: { default: 'allow' },
      sandbox: { cwd: '/tmp/a', env: {} },
      env: {},
      signal: acA.signal,
    });
    const sessionB = await runner.start({
      runId: 'b',
      worktreePath: '/tmp/b',
      systemContract: '',
      prompt: 'b',
      budgets: { wallClockMs: 60_000 },
      permissions: { default: 'allow' },
      sandbox: { cwd: '/tmp/b', env: {} },
      env: {},
      signal: new AbortController().signal,
    });
    await sessionA.abort();
    const fromA: string[] = [];
    const fromB: string[] = [];
    for await (const event of sessionA.events) fromA.push(event.t);
    for await (const event of sessionB.events) fromB.push(event.t);
    expect(fromA).toContain('turn.finished');
    expect(fromB.filter((t) => t === 'turn.finished')).toHaveLength(1);
    expect(fromB).toContain('message.delta');
  });
});
