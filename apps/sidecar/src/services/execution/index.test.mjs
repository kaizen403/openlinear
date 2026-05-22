import { describe, expect, it } from 'vitest';
import * as execution from './index';

describe('execution service index', () => {
  it('exports the public execution workflow surface', () => {
    expect(execution).toEqual(expect.objectContaining({
      executeTask: expect.any(Function),
      cancelTask: expect.any(Function),
      isTaskRunning: expect.any(Function),
      getExecutionLogs: expect.any(Function),
      getRunningTaskCount: expect.any(Function),
      getExecutionStatus: expect.any(Function),
    }));
  });
});
