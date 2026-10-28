import { describe, expect, it } from 'vitest';
import { finalizeUsage, UNKNOWN_USAGE } from '../usage/cost';
import { toAtif, validateAtif } from './atif';
import type { TimedEvent } from './types';

const events: TimedEvent[] = [
  { atMs: 0, event: { t: 'session.started', externalId: 'ses-1', model: { id: 'model-x' } } },
  { atMs: 10, event: { t: 'reasoning.delta', text: 'look at the test' } },
  { atMs: 20, event: { t: 'message.delta', text: 'Reading.' } },
  { atMs: 30, event: { t: 'tool.started', callId: 'c1', name: 'read', input: { filePath: 'a' } } },
  { atMs: 31, event: { t: 'tool.started', callId: 'c2', name: 'bash', input: 'ls' } },
  { atMs: 40, event: { t: 'tool.finished', callId: 'c1', name: 'read', ok: true, summary: 'content' } },
  { atMs: 41, event: { t: 'tool.finished', callId: 'c2', name: 'bash', ok: false, summary: 'boom' } },
  { atMs: 50, event: { t: 'message.delta', text: 'Done.' } },
  { atMs: 60, event: { t: 'turn.finished', turn: 1, reason: 'idle' } },
];

describe('ATIF export', () => {
  it('reconstructs system/user/agent steps with correlated tool calls and observations', () => {
    const usage = finalizeUsage({ tokens: { input: 100, output: 20, cacheRead: 300, cacheWrite: 40, reasoning: 5 }, tokenBasis: 'provider-reported', semantics: 'cache-disjoint', reportedCostUsd: 0.02, reportedCostBasis: 'runner-reported', reportedCostSource: 'claude' }, null);
    const atif = toAtif({ trajectoryId: 't-1', agentName: 'openlinear+opencode', agentVersion: '1.18.32', modelName: 'model-x', startedAt: '2026-10-26T00:00:00.000Z', systemPrompt: 'contract', userPrompt: 'fix it', events, usage });
    expect(validateAtif(atif)).toEqual([]);
    expect(atif.session_id).toBe('ses-1');
    expect(atif.steps.map((s) => [s.step_id, s.source])).toEqual([
      [1, 'system'],
      [2, 'user'],
      [3, 'agent'],
      [4, 'agent'],
    ]);
    const first = atif.steps[2];
    expect(first?.reasoning_content).toBe('look at the test');
    expect(first?.tool_calls?.map((c) => [c.tool_call_id, c.arguments])).toEqual([
      ['c1', { filePath: 'a' }],
      ['c2', { input: 'ls' }],
    ]);
    expect(first?.observation?.results).toEqual([
      { source_call_id: 'c1', content: 'content' },
      { source_call_id: 'c2', content: '[error] boom' },
    ]);
    expect(atif.steps[3]?.message).toBe('Done.');
    // ATIF prompt tokens include cache; disjoint usage is converted, cache writes kept in extra.
    expect(atif.final_metrics).toMatchObject({ total_prompt_tokens: 440, total_cached_tokens: 300, total_completion_tokens: 20, total_cost_usd: 0.02, extra: { cache_creation_input_tokens: 40, cost_basis: 'runner-reported' } });
  });

  it('omits unknown cost and tokens instead of writing zeros', () => {
    const atif = toAtif({ trajectoryId: 't-2', agentName: 'codex', agentVersion: '0.164.0', modelName: null, startedAt: 'not a date', systemPrompt: null, userPrompt: 'x', events: [], usage: finalizeUsage(UNKNOWN_USAGE, null) });
    expect(validateAtif(atif)).toEqual([]);
    expect(atif.final_metrics).toEqual({ total_steps: 1 });
    expect(atif.steps[0]?.timestamp).toBeUndefined();
  });
});
