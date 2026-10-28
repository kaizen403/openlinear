import { beforeEach, describe, expect, it, vi } from 'vitest';

const startPgBossMock = vi.hoisted(() => vi.fn());
const startJobLoopMock = vi.hoisted(() => vi.fn());

vi.mock('../jobs/index', () => ({
  startPgBoss: startPgBossMock,
  startJobLoop: startJobLoopMock,
}));

import { resolveJobsRunner, startBackgroundJobs } from '../jobs/runner';

describe('resolveJobsRunner', () => {
  it('defaults to the worker so API replicas never run job handlers', () => {
    expect(resolveJobsRunner({})).toBe('worker');
    expect(resolveJobsRunner({ OPENLINEAR_JOBS_RUNNER: '' })).toBe('worker');
  });

  it('accepts worker, api and off (case- and whitespace-insensitive)', () => {
    expect(resolveJobsRunner({ OPENLINEAR_JOBS_RUNNER: 'worker' })).toBe('worker');
    expect(resolveJobsRunner({ OPENLINEAR_JOBS_RUNNER: ' API ' })).toBe('api');
    expect(resolveJobsRunner({ OPENLINEAR_JOBS_RUNNER: 'off' })).toBe('off');
  });

  it('refuses an unknown value instead of silently running jobs twice or never', () => {
    expect(() => resolveJobsRunner({ OPENLINEAR_JOBS_RUNNER: 'both' })).toThrow(/OPENLINEAR_JOBS_RUNNER/);
  });
});

describe('startBackgroundJobs', () => {
  beforeEach(() => {
    startPgBossMock.mockReset();
    startJobLoopMock.mockReset();
  });

  it('uses pg-boss when it starts, and then never starts the interval loop', async () => {
    const bossStop = vi.fn(async () => undefined);
    startPgBossMock.mockResolvedValue({ stop: bossStop });

    const jobs = await startBackgroundJobs();

    expect(jobs.mode).toBe('pg-boss');
    expect(startJobLoopMock).not.toHaveBeenCalled();
    await jobs.stop();
    expect(bossStop).toHaveBeenCalledOnce();
  });

  it('falls back to the interval loop only when pg-boss is unavailable', async () => {
    const loopStop = vi.fn();
    startPgBossMock.mockResolvedValue(null);
    startJobLoopMock.mockReturnValue(loopStop);

    const jobs = await startBackgroundJobs();

    expect(jobs.mode).toBe('interval');
    expect(startJobLoopMock).toHaveBeenCalledOnce();
    await jobs.stop();
    expect(loopStop).toHaveBeenCalledOnce();
  });
});
