import { describe, expect, it } from 'vitest';

const { processEvent, extractCleanError, computeBackgroundTaskObservation } = await import(
  './event-stream-processor'
);

function makeState(overrides = {}) {
  return {
    taskId: 'task-1',
    sessionId: 'ses_1',
    promptSent: true,
    cancelled: false,
    status: 'executing',
    backgroundTaskRunning: false,
    backgroundTaskFailure: null,
    backgroundTaskIds: [],
    backgroundTaskResultBuffer: '',
    completedToolKeys: new Set(),
    toolsExecuted: 0,
    filesChanged: 0,
    ...overrides,
  };
}

describe('extractCleanError', () => {
  it('returns defaults for null/undefined', () => {
    expect(extractCleanError(null)).toEqual({
      message: 'Unknown error',
      isAuthError: false,
      isRateLimit: false,
    });
    expect(extractCleanError(undefined)).toEqual({
      message: 'Unknown error',
      isAuthError: false,
      isRateLimit: false,
    });
  });

  it('detects auth and rate limit from strings', () => {
    expect(extractCleanError('unauthorized api key')).toEqual({
      message: 'unauthorized api key',
      isAuthError: true,
      isRateLimit: false,
    });
    expect(extractCleanError('rate limit 429')).toEqual({
      message: 'rate limit 429',
      isAuthError: false,
      isRateLimit: true,
    });
  });

  it('extracts from { data: { message, statusCode } }', () => {
    expect(
      extractCleanError({ data: { message: 'Bad key', statusCode: 401 } }),
    ).toEqual({
      message: 'Bad key',
      isAuthError: true,
      isRateLimit: false,
    });
    expect(
      extractCleanError({ data: { message: 'Too many', statusCode: 429 } }),
    ).toEqual({
      message: 'Too many',
      isAuthError: false,
      isRateLimit: true,
    });
  });

  it('extracts from { message: "..." }', () => {
    expect(extractCleanError({ message: 'api key invalid' })).toEqual({
      message: 'api key invalid',
      isAuthError: true,
      isRateLimit: false,
    });
    expect(extractCleanError({ message: 'rate limit exceeded' })).toEqual({
      message: 'rate limit exceeded',
      isAuthError: false,
      isRateLimit: true,
    });
  });

  it('extracts from { error: { message: "..." } }', () => {
    expect(extractCleanError({ error: { message: 'api key invalid' } })).toEqual({
      message: 'api key invalid',
      isAuthError: true,
      isRateLimit: false,
    });
    expect(extractCleanError({ error: { message: 'Rate limited' } })).toEqual({
      message: 'Rate limited',
      isAuthError: false,
      isRateLimit: true,
    });
  });

  it('returns JSON for unrecognised object shapes', () => {
    expect(extractCleanError({ weird: true })).toEqual({
      message: '{"weird":true}',
      isAuthError: false,
      isRateLimit: false,
    });
  });
});

describe('processEvent', () => {
  it('returns ignore for heartbeat', () => {
    expect(processEvent({ type: 'server.heartbeat' }, makeState())).toEqual([
      { type: 'ignore' },
    ]);
  });

  it('returns empty array for unknown event types', () => {
    expect(processEvent({ type: 'unknown.type' }, makeState())).toEqual([]);
  });
});

describe('computeBackgroundTaskObservation', () => {
  it('returns unchanged buffer when newText is empty', () => {
    expect(computeBackgroundTaskObservation('buf', '')).toEqual({
      newBuffer: 'buf',
      action: null,
      details: '',
    });
  });

  it('appends text and truncates to limit', () => {
    const big = 'x'.repeat(5000);
    const result = computeBackgroundTaskObservation('buf', big);
    expect(result.newBuffer.length).toBeLessThanOrEqual(4000);
    expect(result.action).toBeNull();
  });

  it('detects cancellation', () => {
    const result = computeBackgroundTaskObservation('', 'task cancelled successfully');
    expect(result.action).toBe('cancelled');
    expect(result.details).toContain('cancelled');
  });

  it('detects failure', () => {
    const result = computeBackgroundTaskObservation('', 'Background task failed: oops');
    expect(result.action).toBe('failed');
    expect(result.details).toContain('failed');
  });

  it('detects completion', () => {
    const result = computeBackgroundTaskObservation('', 'Background task completed: done');
    expect(result.action).toBe('completed');
    expect(result.details).toContain('completed');
  });
});
