import { describe, expect, it } from 'vitest';
import {
  formatBatchExecutionMode,
  formatBatchMode,
  getBatchActivityId,
} from './batch-mode';

describe('batch mode presentation helpers', () => {
  it('uses explicit execution labels for every batch mode', () => {
    expect(formatBatchExecutionMode('parallel')).toBe('Parallel Execution');
    expect(formatBatchExecutionMode('queue')).toBe('Queue Execution');
    expect(formatBatchExecutionMode('combined')).toBe('Combined Execution');
    expect(formatBatchExecutionMode(undefined)).toBe('Batch Execution');
  });

  it('keeps compact labels for short UI slots', () => {
    expect(formatBatchMode('parallel')).toBe('Parallel');
    expect(formatBatchMode('queue')).toBe('Queue');
    expect(formatBatchMode('combined')).toBe('Combined');
  });

  it('builds the virtual activity id used by combined execution', () => {
    expect(getBatchActivityId('abc-123')).toBe('batch:abc-123');
  });
});
