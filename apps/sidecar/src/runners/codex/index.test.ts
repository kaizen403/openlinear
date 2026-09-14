import { describe, expect, it } from 'vitest';
import { decodeCodexEvent } from './index';
import { emptyTokenUsage } from '@openlinear/execution-core';

describe('CodexRunner event decode', () => {
  it('uses a high-water mark for aggregated_output', () => {
    const highWater = { output: '', usage: emptyTokenUsage() };
    const first = decodeCodexEvent({
      type: 'item.updated',
      item: { type: 'agent_message', text: 'Hel', aggregated_output: 'Hel' },
    }, highWater);
    const second = decodeCodexEvent({
      type: 'item.updated',
      item: { type: 'agent_message', text: 'Hello', aggregated_output: 'Hello' },
    }, highWater);
    expect(first[0]).toEqual({ t: 'message.delta', text: 'Hel' });
    expect(second[0]).toEqual({ t: 'message.delta', text: 'lo' });
  });

  it('emits usage + idle on turn.completed', () => {
    const events = decodeCodexEvent({
      type: 'turn.completed',
      usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 1, reasoning_output_tokens: 2 },
    }, { output: '', usage: emptyTokenUsage() });
    expect(events.some((e) => e.t === 'usage')).toBe(true);
    expect(events.some((e) => e.t === 'turn.finished')).toBe(true);
  });
});
