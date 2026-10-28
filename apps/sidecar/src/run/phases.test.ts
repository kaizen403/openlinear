import { describe, expect, it } from 'vitest';
import { runPhaseTimings } from './phases';

/** W15: time per phase from the journal's state changes and setup step records. */

const state = (at: number, from: string, to: string) => ({ kind: 'run.state' as const, at, payload: { from, to } });
const setup = (at: number, phase: 'start' | 'end', index: number) => ({ kind: 'progress' as const, at, payload: { setupRecord: { phase, index } } });

describe('W15 run phase timings', () => {
  it('splits a finished run into its phases, setup inside preparing and approval wait inside the agent', () => {
    const timings = runPhaseTimings({
      createdAt: 0,
      finishedAt: 100_000,
      now: 999_999,
      events: [
        state(2_000, 'queued', 'preparing'),
        setup(5_000, 'start', 0),
        setup(9_000, 'end', 0),
        setup(9_000, 'start', 1),
        setup(12_000, 'end', 1),
        state(15_000, 'preparing', 'running'),
        state(40_000, 'running', 'awaiting_approval'),
        state(50_000, 'awaiting_approval', 'running'),
        state(70_000, 'running', 'compacting'),
        state(72_000, 'compacting', 'running'),
        state(80_000, 'running', 'verifying'),
        state(95_000, 'verifying', 'finishing'),
        state(100_000, 'finishing', 'succeeded'),
        { kind: 'log' as const, at: 60_000, payload: { entry: { message: 'noise' } } },
      ],
    });
    expect(timings).toEqual({
      queuedMs: 2_000, preparingMs: 13_000, setupMs: 7_000, agentMs: 65_000, approvalWaitMs: 10_000, verifyingMs: 15_000, finishingMs: 5_000, totalMs: 100_000, live: false,
    });
  });

  it('a live run counts its current phase to now; an unfinished setup step counts to now', () => {
    const timings = runPhaseTimings({
      createdAt: 1_000,
      finishedAt: null,
      now: 31_000,
      events: [state(1_000, 'preparing', 'preparing'), setup(11_000, 'start', 0)],
    });
    expect(timings).toMatchObject({ preparingMs: 30_000, setupMs: 20_000, agentMs: 0, totalMs: 30_000, live: true });
  });

  it('a run that started in preparing (no queue) and failed during it', () => {
    const timings = runPhaseTimings({ createdAt: 0, finishedAt: 4_000, now: 10_000, events: [state(4_000, 'preparing', 'failed')] });
    expect(timings).toMatchObject({ queuedMs: 0, preparingMs: 4_000, agentMs: 0, totalMs: 4_000 });
  });

  it('a live run with no state change yet counts in its current state, not as queued', () => {
    expect(runPhaseTimings({ createdAt: 0, finishedAt: null, now: 5_000, currentState: 'preparing', events: [] })).toMatchObject({ queuedMs: 0, preparingMs: 5_000 });
  });

  it('keeps every state change of a long run (1,000 approval waits) so the last phases count', () => {
    const events = [state(1_000, 'preparing', 'running')];
    let at = 1_000;
    const step = (ms: number, from: string, to: string) => {
      at += ms;
      events.push(state(at, from, to));
    };
    for (let index = 0; index < 1_000; index += 1) {
      step(10, 'running', 'awaiting_approval');
      step(10, 'awaiting_approval', 'running');
    }
    step(1_000, 'running', 'verifying');
    step(2_000, 'verifying', 'finishing');
    step(500, 'finishing', 'succeeded');
    const timings = runPhaseTimings({ createdAt: 0, finishedAt: at, now: at, events });
    expect(timings).toMatchObject({ verifyingMs: 2_000, finishingMs: 500, approvalWaitMs: 10_000 });
  });

  it('never counts past the finish or before creation', () => {
    const timings = runPhaseTimings({ createdAt: 10_000, finishedAt: 20_000, now: 0, events: [state(5_000, 'queued', 'running'), state(30_000, 'running', 'succeeded')] });
    expect(timings).toMatchObject({ agentMs: 10_000, queuedMs: 0, totalMs: 10_000 });
  });
});
