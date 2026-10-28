import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synthesizeRecording } from '../../fakes/recordings';
import { parseManifest } from '../../manifest/schema';
import { loadHoldout, materializeBaseRepo, cloneForTrial, type BaseRepo } from '../../tasks/holdout';
import { SAMPLE_TASKS, writeSampleHoldout } from '../../tasks/samples';
import type { LoadedTask } from '../../tasks/types';
import { testConfiguration, testManifestInput } from '../../testing/fixtures';
import type { TrialContext } from '../types';
import { capturePatch } from '../workspace';
import { buildNativeInvocation } from './commands';
import { NativeCliRunner, NativeRunnerRefused } from './native-runner';
import { codeForProviderError, createNativeParser, type ExitInfo } from './parsers';

const exit = (overrides: Partial<ExitInfo> = {}): ExitInfo => ({ code: 0, signal: null, timedOut: false, cancelled: false, spawnError: null, ...overrides });
const feed = (format: Parameters<typeof createNativeParser>[0], lines: unknown[]) => {
  const parser = createNativeParser(format);
  const events = lines.flatMap((line) => parser.push(typeof line === 'string' ? line : JSON.stringify(line)));
  return { parser, events };
};

describe('native invocations', () => {
  const base = { binary: 'bin', worktree: '/w', prompt: 'fix it', provider: 'anthropic', model: 'm-1', effort: null, maxTurns: null, maxUsd: null, disableWebTools: true };
  it('builds documented headless argv for each CLI', () => {
    const claude = buildNativeInvocation({ ...base, runner: 'claude-code', maxTurns: 40, maxUsd: 10 });
    expect(claude.args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'm-1', '--permission-mode', 'bypassPermissions', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', 'user',
      '--disallowedTools', 'WebFetch,WebSearch', '--max-turns', '40', '--max-budget-usd', '10',
    ]);
    expect(claude.stdin).toBe('fix it');
    const codex = buildNativeInvocation({ ...base, runner: 'codex', provider: 'openai', effort: 'high' });
    expect(codex.args).toEqual(['exec', '--json', '--model', 'm-1', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '-C', '/w', '-c', 'model_reasoning_effort="high"', '-']);
    const opencode = buildNativeInvocation({ ...base, runner: 'opencode', provider: 'openrouter' });
    expect(opencode.args).toEqual(['run', '--format', 'json', '--pure', '--auto', '--model', 'openrouter/m-1', '--dir', '/w', 'fix it']);
    expect(opencode.stdin).toBeNull();
  });
});

describe('native stream parsers', () => {
  it('maps provider errors to codes', () => {
    expect(codeForProviderError(529, 'x')).toBe('overloaded');
    expect(codeForProviderError(null, 'Rate limit exceeded')).toBe('rate_limit');
    expect(codeForProviderError(503, '')).toBe('server_error');
    expect(codeForProviderError(401, '')).toBe('auth');
    expect(codeForProviderError(null, 'prompt is too long')).toBe('context_overflow');
    expect(codeForProviderError(null, 'the model refused')).toBe('refusal');
    expect(codeForProviderError(null, 'something odd')).toBe('provider_error');
  });

  it('Claude Code: events, model, usage from modelUsage, runner-reported cost', () => {
    const { parser, events } = feed('claude-stream-json', [
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-x' },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: 'src/a.ts' } }], usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      'not json',
      { type: 'mystery' },
      { type: 'result', subtype: 'success', is_error: false, num_turns: 2, total_cost_usd: 0.5, modelUsage: { 'claude-x': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 }, 'claude-haiku': { inputTokens: 10, outputTokens: 2 } } },
    ]);
    expect(events.map((e) => e.t)).toEqual(['session.started', 'turn.started', 'message.delta', 'tool.started', 'tool.finished', 'file.changed', 'diagnostic', 'diagnostic', 'turn.finished']);
    const summary = parser.finish(exit());
    expect(summary).toMatchObject({ termination: 'completed', observedModel: 'claude-x' });
    expect(summary.usage).toMatchObject({ tokens: { input: 110, output: 22, cacheRead: 300, cacheWrite: 40, reasoning: 0 }, semantics: 'cache-disjoint', reportedCostUsd: 0.5, reportedCostBasis: 'runner-reported' });
  });

  it('Claude Code: max turns, overload, refusal and EOF', () => {
    const init = { type: 'system', subtype: 'init', session_id: 's', model: 'm' };
    expect(feed('claude-stream-json', [init, { type: 'result', subtype: 'error_max_turns', is_error: true }]).parser.finish(exit()).termination).toBe('budget');
    expect(feed('claude-stream-json', [init, { type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 529, errors: ['Overloaded'] }]).parser.finish(exit({ code: 1 })).termination).toBe('infra');
    expect(feed('claude-stream-json', [init, { type: 'assistant', message: { id: 'm', stop_reason: 'refusal', content: [] } }, { type: 'result', subtype: 'success', is_error: false }]).parser.finish(exit()).termination).toBe('refused');
    const eof = feed('claude-stream-json', [init]).parser.finish(exit({ code: 1 }));
    expect(eof).toMatchObject({ termination: 'agent-error' });
    expect(eof.usage.tokens).toBeNull();
    expect(feed('claude-stream-json', [init]).parser.finish(exit({ code: null, timedOut: true })).termination).toBe('timeout');
  });

  it('Codex: items, per-turn usage deltas (cache inside input), no cost', () => {
    const { parser, events } = feed('codex-jsonl', [
      { type: 'thread.started', thread_id: 'th' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls', aggregated_output: 'x', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }], status: 'completed' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4 } },
    ]);
    expect(events.filter((e) => e.t === 'file.changed')).toEqual([{ t: 'file.changed', path: 'a.ts', kind: 'edit' }, { t: 'file.changed', path: 'b.ts', kind: 'create' }]);
    const summary = parser.finish(exit());
    expect(summary).toMatchObject({ termination: 'completed', observedModel: null });
    expect(summary.usage).toMatchObject({ tokens: { input: 100, cacheRead: 60, output: 10, reasoning: 4, cacheWrite: 0 }, semantics: 'cache-in-input', reportedCostUsd: null });
    expect(feed('codex-jsonl', [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.failed', error: { message: '429 Too Many Requests' } }]).parser.finish(exit({ code: 1 })).termination).toBe('infra');
    expect(feed('codex-jsonl', [{ type: 'thread.started', thread_id: 't' }]).parser.finish(exit({ code: 1 })).termination).toBe('agent-error');
  });

  it('OpenCode: tool_use / step_finish / error objects as printed by `opencode run --format json`', () => {
    const { parser, events } = feed('opencode-json', [
      { type: 'step_start', timestamp: 1, sessionID: 'ses', part: { type: 'step-start' } },
      { type: 'tool_use', timestamp: 2, sessionID: 'ses', part: { type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed', input: { filePath: 'src/a.ts' }, output: '' } } },
      { type: 'text', timestamp: 3, sessionID: 'ses', part: { type: 'text', text: 'done' } },
      { type: 'step_finish', timestamp: 4, sessionID: 'ses', part: { type: 'step-finish', reason: 'stop', cost: 0.25, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 7, write: 3 } } } },
    ]);
    expect(events.map((e) => e.t)).toEqual(['session.started', 'turn.started', 'tool.started', 'tool.finished', 'file.changed', 'message.delta', 'usage']);
    const summary = parser.finish(exit());
    expect(summary.termination).toBe('completed');
    expect(summary.usage).toMatchObject({ tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 7, cacheWrite: 3 }, semantics: 'cache-disjoint', reportedCostUsd: 0.25 });
    const overloaded = feed('opencode-json', [{ type: 'error', sessionID: 's', error: { name: 'APIError', data: { message: 'Overloaded', statusCode: 529 } } }]).parser.finish(exit({ code: 1 }));
    expect(overloaded.termination).toBe('infra');
    expect(feed('opencode-json', [{ type: 'step_start', sessionID: 's', part: {} }]).parser.finish(exit({ code: 0 })).termination).toBe('agent-error');
  });
});

describe('NativeCliRunner (FAKE replay through a real child process)', () => {
  let root: string;
  let tasks: LoadedTask[];
  const bases = new Map<string, BaseRepo>();
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'evals-native-'));
    await writeSampleHoldout(join(root, 'holdout'));
    tasks = (await loadHoldout(join(root, 'holdout'))).tasks;
    for (const task of tasks) bases.set(task.spec.id, await materializeBaseRepo(task, join(root, 'work')));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function context(taskId: string, name: string, agentTimeoutMs = 5000): Promise<TrialContext> {
    const task = tasks.find((t) => t.spec.id === taskId) as LoadedTask;
    const base = bases.get(taskId) as BaseRepo;
    const scratch = join(root, 'trials', name);
    await mkdir(scratch, { recursive: true });
    await cloneForTrial(base, join(scratch, 'worktree'));
    const manifest = parseManifest(testManifestInput({ budgets: { agentTimeoutMs, verifierTimeoutMs: 30_000 } }));
    return {
      trialId: name,
      attempt: 1,
      repeat: 1,
      task,
      configuration: testConfiguration('native', { runner: { id: 'claude-code', binaryVersion: 'replay', binarySha256: null, sdkVersion: null, mode: 'fake' } }),
      manifest,
      worktree: join(scratch, 'worktree'),
      baseSha: base.baseSha,
      scratchDir: scratch,
      prompt: task.instruction,
      systemContract: 'contract',
      sealed: false,
      signal: new AbortController().signal,
    };
  }

  for (const [runner, format] of [['claude-code', 'claude-stream-json'], ['codex', 'codex-jsonl'], ['opencode', 'opencode-json']] as const) {
    it(`${runner}: replays a fix, records the would-be argv, edits the worktree`, async () => {
      const source = SAMPLE_TASKS[0];
      if (!source) throw new Error('no sample');
      const native = new NativeCliRunner({ runner, mode: 'fake', killGraceMs: 300, pickRecording: () => synthesizeRecording({ task: source, kind: 'fix', runner, model: 'm', format, seedLabel: 'x', timeScale: 0.01 }) });
      const ctx = await context(source.id, `${runner}-fix`);
      const result = await native.run(ctx);
      expect(result.termination).toBe('completed');
      expect(result.invocation?.fake).toBe(true);
      expect(result.invocation?.command).toBe(runner === 'claude-code' ? 'claude' : runner);
      expect(result.nativeLines.length).toBeGreaterThan(3);
      expect(result.usage.tokens).not.toBeNull();
      const patch = await capturePatch(ctx.worktree, ctx.baseSha);
      expect(patch).toContain('Math.min(a, b)');
      expect(await readFile(join(ctx.worktree, 'src/range.mjs'), 'utf8')).toContain('hi = Math.max');
    });
  }

  it('kills a hung CLI at the wall-clock budget and keeps the partial edit', async () => {
    const source = SAMPLE_TASKS[1];
    if (!source) throw new Error('no sample');
    const native = new NativeCliRunner({ runner: 'opencode', mode: 'fake', killGraceMs: 300, pickRecording: () => synthesizeRecording({ task: source, kind: 'timeout', runner: 'opencode', model: 'm', format: 'opencode-json', seedLabel: 'y', timeScale: 0.01 }) });
    const ctx = await context(source.id, 'hang', 600);
    const started = Date.now();
    const result = await native.run(ctx);
    expect(result.termination).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await capturePatch(ctx.worktree, ctx.baseSha)).toContain('src/slugify.mjs');
  });

  it('refuses real CLIs unless a funded-run driver explicitly allows it', async () => {
    const ctx = await context('sum-range-inclusive', 'real');
    await expect(new NativeCliRunner({ runner: 'codex', mode: 'real' }).run(ctx)).rejects.toThrow(NativeRunnerRefused);
  });
});
