import { describe, expect, it } from 'vitest';
import {
  batchActivityId,
  batchIdFromActivityId,
  formatExecutionMode,
  getInitialBatchLaunchIndexes,
} from './batch-mode';

describe('sidecar batch mode helpers', () => {
  it('uses exact activity labels for every execution mode', () => {
    expect(formatExecutionMode('parallel')).toBe('Parallel Execution');
    expect(formatExecutionMode('queue')).toBe('Queue Execution');
    expect(formatExecutionMode('combined')).toBe('Combined Execution');
  });

  it('routes combined activity through a virtual batch task id', () => {
    expect(batchActivityId('batch-1')).toBe('batch:batch-1');
    expect(batchIdFromActivityId('batch:batch-1')).toBe('batch-1');
    expect(batchIdFromActivityId('task-1')).toBeNull();
  });

  it('starts all selected issues for parallel execution', () => {
    expect(getInitialBatchLaunchIndexes('parallel', 4)).toEqual([0, 1, 2, 3]);
  });

  it('starts only the first issue for queue execution', () => {
    expect(getInitialBatchLaunchIndexes('queue', 4)).toEqual([0]);
  });

  it('does not launch per-issue sessions for combined execution', () => {
    expect(getInitialBatchLaunchIndexes('combined', 4)).toEqual([]);
  });
});
