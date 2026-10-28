import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_STATES,
  CONTROL_STATUS_FOR_STATE,
  EFFECT_RECOVERY,
  LEGACY_PROGRESS_STATUS,
  RUN_EFFECT_KINDS,
  RUN_STATES,
  RUN_TRANSITIONS,
  RunTransitionError,
  TERMINAL_RUN_STATES,
  admitRunRequest,
  assertTransition,
  canTransition,
  commitCarriesEffect,
  decideRunRecovery,
  isRunEffectKind,
  isRunState,
  isTerminalRunState,
  runEffectKey,
  type RunRecoveryInput,
  type RunState,
} from './run-contract';

describe('run state machine', () => {
  it('has no outgoing transition from a terminal state (one terminal decision)', () => {
    for (const state of TERMINAL_RUN_STATES) {
      expect(RUN_TRANSITIONS[state]).toEqual([]);
      for (const to of RUN_STATES) expect(canTransition(state, to)).toBe(false);
    }
  });

  it('reaches a terminal state from every non-terminal state', () => {
    for (const state of RUN_STATES) {
      if (isTerminalRunState(state)) continue;
      expect(RUN_TRANSITIONS[state].some((to) => isTerminalRunState(to))).toBe(true);
      // Cancellation is possible in every live state (queued … finishing).
      expect(canTransition(state, 'cancelled')).toBe(true);
      // Losing authority is possible in every live state.
      expect(canTransition(state, 'abandoned')).toBe(true);
    }
  });

  it('only reaches succeeded through finishing (publication)', () => {
    const into = RUN_STATES.filter((state) => canTransition(state, 'succeeded'));
    expect(into).toEqual(['finishing']);
  });

  it('never re-enters setup once the agent ran', () => {
    for (const state of [...AGENT_RUN_STATES, 'finishing'] satisfies RunState[]) {
      expect(canTransition(state, 'preparing')).toBe(false);
      expect(canTransition(state, 'queued')).toBe(false);
    }
  });

  it('asserts transitions with a typed error', () => {
    expect(() => assertTransition('running', 'finishing')).not.toThrow();
    expect(() => assertTransition('succeeded', 'failed')).toThrow(RunTransitionError);
    try {
      assertTransition('cancelled', 'running');
    } catch (error) {
      expect(error).toMatchObject({ from: 'cancelled', to: 'running' });
    }
  });

  it('maps every state to control-plane statuses and a legacy progress status', () => {
    for (const state of RUN_STATES) {
      expect(CONTROL_STATUS_FOR_STATE[state].length).toBeGreaterThan(0);
      expect(LEGACY_PROGRESS_STATUS[state]).toMatch(/^[a-z_]+$/);
    }
    expect(isRunState('running')).toBe(true);
    expect(isRunState('bogus')).toBe(false);
    expect(isRunState(3)).toBe(false);
  });
});

describe('effect ledger', () => {
  it('has a recovery rule for every effect kind, and never resubmits a prompt or a claim', () => {
    for (const kind of RUN_EFFECT_KINDS) {
      expect(EFFECT_RECOVERY[kind]).toBeDefined();
      expect(isRunEffectKind(kind)).toBe(true);
    }
    expect(EFFECT_RECOVERY['prompt.submit']).toMatchObject({ action: 'probe-runtime', redispatchWhenAbsent: false });
    expect(EFFECT_RECOVERY['attempt.claim'].redispatchWhenAbsent).toBe(false);
    expect(EFFECT_RECOVERY['pr.create'].action).toBe('probe-pull-request');
    expect(isRunEffectKind('git.rebase')).toBe(false);
  });

  it('builds deterministic idempotency keys', () => {
    expect(runEffectKey('r1', 'git.commit')).toBe('r1:git.commit');
    expect(runEffectKey('r1', 'git.push', 'abc123')).toBe('r1:git.push:abc123');
    expect(runEffectKey('r1', 'git.push', 'abc123')).toBe(runEffectKey('r1', 'git.push', 'abc123'));
    expect(() => runEffectKey('', 'git.commit')).toThrow();
    expect(() => runEffectKey('a:b', 'git.commit')).toThrow();
  });

  it('recognises the commit trailer only as a whole line', () => {
    const key = runEffectKey('r1', 'git.commit');
    expect(commitCarriesEffect(`feat: x\n\nOpenLinear-Effect: ${key}\n`, key)).toBe(true);
    expect(commitCarriesEffect(`feat: x\n\nOpenLinear-Effect: ${key}-other\n`, key)).toBe(false);
    expect(commitCarriesEffect(`feat: OpenLinear-Effect: ${key}`, key)).toBe(false);
  });
});

describe('decideRunRecovery', () => {
  const base: RunRecoveryInput = {
    state: 'running',
    controlPlane: 'active',
    controlStatus: 'running',
    cancelRequested: false,
    promptEffect: 'confirmed',
    runtime: 'busy',
  };

  it('re-drives terminal effects before anything else', () => {
    for (const state of TERMINAL_RUN_STATES) {
      expect(decideRunRecovery({ ...base, state, controlPlane: 'unreachable' })).toEqual({ action: 'terminalize' });
    }
  });

  it('waits when the control plane is unreachable and abandons when authority is lost', () => {
    expect(decideRunRecovery({ ...base, controlPlane: 'unreachable' })).toEqual({ action: 'wait' });
    expect(decideRunRecovery({ ...base, controlPlane: 'lost' }).action).toBe('abandon');
  });

  it('honours a cancellation requested during the outage', () => {
    expect(decideRunRecovery({ ...base, cancelRequested: true })).toEqual({ action: 'cancel' });
  });

  it('fails setup-only runs instead of resuming them', () => {
    expect(decideRunRecovery({ ...base, state: 'queued' }).action).toBe('fail');
    expect(decideRunRecovery({ ...base, state: 'preparing' }).action).toBe('fail');
    expect(decideRunRecovery({ ...base, promptEffect: 'absent' }).action).toBe('fail');
  });

  it('never resubmits a dispatched prompt', () => {
    for (const promptEffect of ['pending', 'confirmed'] as const) {
      expect(decideRunRecovery({ ...base, promptEffect, runtime: 'busy' })).toEqual({ action: 'reattach' });
      expect(decideRunRecovery({ ...base, promptEffect, runtime: 'idle' })).toEqual({ action: 'finish' });
      expect(decideRunRecovery({ ...base, promptEffect, runtime: 'idle-error' }).action).toBe('fail');
      expect(decideRunRecovery({ ...base, promptEffect, runtime: 'missing' }).action).toBe('recovery-required');
      expect(decideRunRecovery({ ...base, promptEffect, runtime: 'unreachable' }).action).toBe('recovery-required');
      expect(decideRunRecovery({ ...base, promptEffect, runtime: 'not-probed' }).action).toBe('recovery-required');
    }
  });

  it('never reattaches or publishes a process runtime that died with the sidecar (W07a detached)', () => {
    for (const state of ['running', 'awaiting_approval', 'compacting'] as const) {
      for (const promptEffect of ['pending', 'confirmed'] as const) {
        const decision = decideRunRecovery({ ...base, state, promptEffect, runtime: 'detached' });
        expect(decision.action).toBe('recovery-required');
        expect(decision).toMatchObject({ reason: expect.stringContaining('cannot be re-attached') });
      }
    }
    // Cancellation and authority still win over the runtime probe.
    expect(decideRunRecovery({ ...base, runtime: 'detached', cancelRequested: true })).toEqual({ action: 'cancel' });
    expect(decideRunRecovery({ ...base, runtime: 'detached', controlPlane: 'lost' }).action).toBe('abandon');
  });

  it('resumes publication from finishing', () => {
    expect(decideRunRecovery({ ...base, state: 'finishing' })).toEqual({ action: 'resume-finishing' });
    expect(decideRunRecovery({ ...base, state: 'awaiting_approval', runtime: 'busy' })).toEqual({ action: 'reattach' });
  });
});

describe('admitRunRequest', () => {
  it('counts pending work, queues fairly behind earlier requests, and bounds the queue', () => {
    expect(admitRunRequest({ active: 0, queued: 0, parallelLimit: 2, maxQueued: 2 })).toEqual({ kind: 'start' });
    expect(admitRunRequest({ active: 2, queued: 0, parallelLimit: 2, maxQueued: 2 })).toEqual({ kind: 'queue' });
    // A free slot does not let a newcomer overtake the queue.
    expect(admitRunRequest({ active: 1, queued: 1, parallelLimit: 2, maxQueued: 2 })).toEqual({ kind: 'queue' });
    expect(admitRunRequest({ active: 2, queued: 2, parallelLimit: 2, maxQueued: 2 }).kind).toBe('reject');
    expect(admitRunRequest({ active: 0, queued: 0, parallelLimit: 0, maxQueued: 0 })).toEqual({ kind: 'start' });
  });
});
