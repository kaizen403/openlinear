import { describe, expect, it } from 'vitest';
import { checkWatchdogs, createWatchdogState, defaultBudgets, recordUsage } from './watchdogs';
import { approvalDeadlineExceeded } from './watchdogs';
import { cancelRun } from './cancel';
import { FakeAgentRunner } from '@openlinear/execution-core';
import { resolveAgentId } from './resolve-agent';
import { assertSidecarPersistenceMode } from '../persistence/boot';

describe('watchdogs', () => {
  it('trips transport, no-progress, and budget independently and suspends', () => {
    const budgets = { transportMs: 60_000, noProgressMs: 20 * 60 * 1000, wallClockMs: 1000, maxTokens: 10, maxUsd: 1 };
    const state = createWatchdogState(0);
    expect(checkWatchdogs(state, budgets, 500)).toBeNull();
    expect(checkWatchdogs(state, budgets, 1001)?.kind).toBe('budget');
    const transport = createWatchdogState(0);
    expect(checkWatchdogs(transport, defaultBudgets(), 61_000)?.kind).toBe('transport');
    recordUsage(state, 11, 0);
    const tokenState = createWatchdogState(0);
    recordUsage(tokenState, 11, 0);
    const trip = checkWatchdogs(tokenState, { ...defaultBudgets(), maxTokens: 10 }, 10);
    expect(trip?.kind).toBe('budget');
    if (trip?.kind === 'budget') expect(trip.reason).toBe('tokens');
    tokenState.suspended = true;
    expect(checkWatchdogs(tokenState, { ...defaultBudgets(), maxTokens: 10 }, 10)).toBeNull();
  });

  it('denies approvals after 10 minutes', () => {
    expect(approvalDeadlineExceeded(0, 10 * 60 * 1000)).toBe(true);
    expect(approvalDeadlineExceeded(0, 60_000)).toBe(false);
  });
});

describe('cancel chain', () => {
  it('interrupt then abort', async () => {
    const runner = new FakeAgentRunner();
    const session = await runner.start({
      runId: 'x',
      worktreePath: '/tmp/x',
      systemContract: '',
      prompt: 'x',
      budgets: { wallClockMs: 1000 },
      permissions: { default: 'allow' },
      sandbox: { cwd: '/tmp/x', env: {} },
      env: {},
      signal: new AbortController().signal,
    });
    await cancelRun({ session }, 0);
    expect(runner.interruptCount).toBe(1);
    expect(runner.abortCount).toBe(1);
  });
});

describe('agent selection', () => {
  it('prefers task agent then project default', () => {
    expect(resolveAgentId({ taskAgent: 'codex' })).toBe('codex');
    expect(resolveAgentId({ projectDefaultAgent: 'codex' })).toBe('codex');
    expect(resolveAgentId({})).toBe('opencode');
  });
});

describe('persistence boot', () => {
  it('refuses DATABASE_URL without --with-cloud-api outside tests', () => {
    expect(() => assertSidecarPersistenceMode(
      { NODE_ENV: 'production', DATABASE_URL: 'postgresql://openlinear:openlinear@127.0.0.1:55432/openlinear_test' },
      ['node'],
    )).toThrow(/DATABASE_URL is set/);
    expect(() => assertSidecarPersistenceMode(
      { NODE_ENV: 'production', DATABASE_URL: 'postgresql://openlinear:openlinear@127.0.0.1:55432/openlinear_test', OPENLINEAR_WITH_CLOUD_API: '1' },
      ['node'],
    )).not.toThrow();
    expect(() => assertSidecarPersistenceMode(
      { NODE_ENV: 'production', DATABASE_URL: 'postgresql://x:x@neon.example/neondb', OPENLINEAR_WITH_CLOUD_API: '1' },
      ['node'],
    )).toThrow(/non-loopback/);
  });
});
