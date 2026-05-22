import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendReasoningDelta,
  appendTextDelta,
  cleanupDeltaBuffer,
  clearThinking,
  flushDeltaBuffer,
  getOrCreateBuffer,
  markThinking,
} from './delta-buffer';

describe('delta buffer', () => {
  let emit;

  beforeEach(() => {
    vi.useFakeTimers();
    emit = vi.fn();
  });

  afterEach(() => {
    cleanupDeltaBuffer('task-1');
    cleanupDeltaBuffer('task-idle');
    cleanupDeltaBuffer('missing');
    vi.useRealTimers();
  });

  it('buffers text deltas and emits complete messages after debounce', () => {
    getOrCreateBuffer('task-1', emit);

    appendTextDelta('task-1', 'Hello ');
    appendTextDelta('task-1', 'world');
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(emit).toHaveBeenCalledWith('Hello world');
  });

  it('flushes reasoning with a thinking prefix and length cap', () => {
    getOrCreateBuffer('task-1', emit);

    appendReasoningDelta('task-1', 'x'.repeat(250));
    flushDeltaBuffer('task-1');

    expect(emit).toHaveBeenCalledWith(`Thinking: ${'x'.repeat(200)}`);
  });

  it('marks thinking only once until cleared or flushed', () => {
    getOrCreateBuffer('task-1', emit);

    expect(markThinking('missing')).toBe(true);
    expect(markThinking('task-1')).toBe(true);
    expect(markThinking('task-1')).toBe(false);
    clearThinking('task-1');
    expect(markThinking('task-1')).toBe(true);
    flushDeltaBuffer('task-1');
    expect(markThinking('task-1')).toBe(true);
  });

  it('ignores missing buffers and suppresses very large text log entries', () => {
    appendTextDelta('missing', 'ignored');
    appendReasoningDelta('missing', 'ignored');
    flushDeltaBuffer('missing');

    getOrCreateBuffer('task-1', emit);
    appendTextDelta('task-1', 'x'.repeat(500));
    vi.advanceTimersByTime(800);

    expect(emit).not.toHaveBeenCalled();
  });

  it('cleans up pending timers', () => {
    getOrCreateBuffer('task-1', emit);
    appendTextDelta('task-1', 'pending');
    appendReasoningDelta('task-1', 'pending thought');
    cleanupDeltaBuffer('task-1');

    vi.advanceTimersByTime(800);

    expect(emit).not.toHaveBeenCalled();
  });

  it('emits reasoning after debounce', () => {
    getOrCreateBuffer('task-1', emit);
    appendReasoningDelta('task-1', 'delayed thought');

    vi.advanceTimersByTime(800);

    expect(emit).toHaveBeenCalledWith('Thinking: delayed thought');
  });

  it('debounces repeated reasoning deltas and reuses existing buffers', () => {
    getOrCreateBuffer('task-1', emit);
    getOrCreateBuffer('task-1', emit);

    appendReasoningDelta('task-1', 'first ');
    appendReasoningDelta('task-1', 'second');

    vi.advanceTimersByTime(799);
    expect(emit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenCalledWith('Thinking: first second');
  });

  it('cleans up buffer after idle TTL expires', () => {
    getOrCreateBuffer('task-idle', emit);

    vi.advanceTimersByTime(35 * 60 * 1000);
    appendTextDelta('task-idle', 'hello');
    vi.advanceTimersByTime(800);

    expect(emit).not.toHaveBeenCalled();
  });
});
