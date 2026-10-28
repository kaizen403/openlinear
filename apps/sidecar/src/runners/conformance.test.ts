import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentRunner, AgentSession, RunnerId, StartInput, TokenUsage } from '@openlinear/execution-core';
import { reduceUsage } from '@openlinear/execution-core';

vi.mock('../services/opencode', () => ({
  getClientForUser: vi.fn(),
  getOpenCodeStatus: vi.fn(() => ({ mode: 'host', serverUrl: null, running: false, restartAttempts: 0 })),
}));

import { SandboxUnavailableError } from '../sandbox/errors';
import { buildSandboxAgentEnv, isSecretLikeEnvName } from '../sandbox/env';
import { OpenCodeRunner } from './opencode/index';
import type { FakeInvocation, FakeScenario, FakeStep } from './testing/fake-cli';
import {
  CLAUDE_EXPECTED_USAGE,
  CODEX_EXPECTED_USAGE,
  OPENCODE_EXPECTED_USAGE,
  OPENCODE_SESSION,
  claudeEof,
  claudeHangAt,
  claudeMalformed,
  claudeSuccess,
  codexEof,
  codexHangAt,
  codexMalformed,
  codexSuccessSteps,
  openCodeMalformed,
  openCodeSuccess,
  openCodeUntil,
  type Phase,
} from './testing/fixtures';
import { PLANTED_SECRETS, claudeHarness, closed as processClosed, codexHarness, collect, drain, isAlive, readUntil } from './testing/harness';

/**
 * W07 runner conformance: one contract, three adapters. Claude Code and
 * Codex run real child processes (fake CLIs replaying recorded streams)
 * through the real launcher with a pass-through sandbox provider; OpenCode
 * runs against a fake SDK client replaying recorded bus events. No model is
 * contacted anywhere.
 */

type Method = 'interrupt' | 'abort' | 'signal';
type ConfirmedBy = 'runner-ack' | 'server-ack' | 'process-exit' | 'not-started';
type Scenario = 'success' | 'resume' | 'eof' | 'malformed' | Phase;

let root = '';
let worktree = '';

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-runner-conformance-')));
  worktree = join(root, 'worktree');
  mkdirSync(join(worktree, 'src'), { recursive: true });
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function startInput(signal: AbortSignal, env: Record<string, string> = {}): StartInput {
  return {
    runId: 'run-conformance',
    worktreePath: worktree,
    systemContract: 'Fixture contract: verify before finishing.',
    prompt: 'Fix the failing test.',
    model: { provider: 'anthropic', id: 'fixture-model' },
    budgets: { wallClockMs: 60_000 },
    permissions: { default: 'allow' },
    sandbox: { cwd: worktree, env: {} },
    env,
    signal,
  };
}

interface Harness {
  runner: AgentRunner;
  /** True once the runtime received the prompt. */
  started(): boolean;
  /** Number of processes spawned (process runners) or prompts sent (OpenCode). */
  spawns(): number;
  invocation(): FakeInvocation | undefined;
  /** Per-run credential the adapter is expected to pass. */
  runEnv: Record<string, string>;
}

interface Driver {
  id: RunnerId;
  harness(scenario: Scenario, extra?: Partial<FakeScenario> & { unavailable?: boolean }): Harness;
  resumeId: string;
  expectedUsage: TokenUsage;
  expectedTool: { callId: string; name: string };
  expectedFile: string;
  confirmedBy(method: Method, phase: Phase): ConfirmedBy;
  /** Waits until the runtime process/stream is gone after a terminal event. */
  closed(session: AgentSession): Promise<void>;
}

function processHarness(kind: 'claude' | 'codex', steps: FakeStep[], extra: Partial<FakeScenario> & { unavailable?: boolean } = {}): Harness {
  const h = kind === 'claude' ? claudeHarness(root, steps, extra) : codexHarness(root, steps, extra);
  return {
    runner: h.runner,
    runEnv: kind === 'claude' ? { ANTHROPIC_API_KEY: 'sk-ant-per-run-FIXTURE' } : { OPENAI_API_KEY: 'sk-per-run-FIXTURE' },
    started: h.started,
    spawns: h.spawns,
    invocation: h.invocation,
  };
}

type RunnerClient = Awaited<ReturnType<NonNullable<ConstructorParameters<typeof OpenCodeRunner>[0]>>>;

function openCodeHarness(events: unknown[], hang: boolean, unavailable = false): Harness & { prompts: unknown[] } {
  const prompts: unknown[] = [];
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield* events;
      if (hang) await new Promise<void>(() => undefined);
    },
  };
  const client = {
    session: {
      create: vi.fn(async () => ({ data: { id: OPENCODE_SESSION } })),
      promptAsync: vi.fn(async (body: unknown) => {
        prompts.push(body);
        return {};
      }),
      // The SDK's real answer shape: `{ data: true }` is OpenCode's positive
      // abort receipt (W07a: a bare resolved call is not one).
      abort: vi.fn(async () => ({ data: true })),
    },
    event: { subscribe: vi.fn(async () => ({ stream })) },
  };
  const runner = new OpenCodeRunner(async () => {
    if (unavailable) throw new SandboxUnavailableError('No verified sandbox is available', ['fixture: provider unavailable']);
    return client as unknown as RunnerClient;
  });
  const promptText = (body: unknown): string => {
    const parts = (body as { body?: { parts?: Array<{ text?: string }> } }).body?.parts ?? [];
    return parts.map((part) => part.text ?? '').join('');
  };
  return {
    runner,
    prompts,
    runEnv: {},
    started: () => prompts.length > 0,
    spawns: () => prompts.length,
    invocation: () => (prompts[0] ? { event: 'start', prompt: promptText(prompts[0]) } : undefined),
  };
}




const drivers: Driver[] = [
  {
    id: 'claude-code',
    harness: (scenario, extra) => processHarness('claude',
      scenario === 'success' || scenario === 'resume' ? claudeSuccess(worktree)
        : scenario === 'eof' ? claudeEof()
          : scenario === 'malformed' ? claudeMalformed(worktree)
            : claudeHangAt(scenario, worktree), extra),
    resumeId: '6f9619ff-8b86-4011-b42d-00c04fc964ff',
    expectedUsage: CLAUDE_EXPECTED_USAGE,
    expectedTool: { callId: 'toolu_1', name: 'Edit' },
    expectedFile: 'src/a.ts',
    // In-band interrupt once init was seen; before that only the process can be stopped.
    confirmedBy: (method, phase) => (method !== 'abort' && phase !== 'startup' ? 'runner-ack' : 'process-exit'),
    closed: processClosed,
  },
  {
    id: 'codex',
    harness: (scenario, extra) => processHarness('codex',
      scenario === 'success' ? codexSuccessSteps()
        : scenario === 'resume' ? codexSuccessSteps('thread-saved')
        : scenario === 'eof' ? codexEof()
          : scenario === 'malformed' ? codexMalformed()
            : codexHangAt(scenario), extra),
    resumeId: 'thread-saved',
    expectedUsage: CODEX_EXPECTED_USAGE,
    expectedTool: { callId: 'cmd-1', name: 'bash' },
    expectedFile: 'src/a.ts',
    confirmedBy: () => 'process-exit',
    closed: processClosed,
  },
  {
    id: 'opencode',
    harness: (scenario, extra) => {
      if (scenario === 'success' || scenario === 'resume') return openCodeHarness(openCodeSuccess(), false, extra?.unavailable);
      if (scenario === 'eof') return openCodeHarness(openCodeSuccess().slice(0, 3), false);
      if (scenario === 'malformed') return openCodeHarness(openCodeMalformed(), false);
      return openCodeHarness(openCodeUntil(scenario), true);
    },
    resumeId: OPENCODE_SESSION,
    expectedUsage: OPENCODE_EXPECTED_USAGE,
    expectedTool: { callId: 'call-1', name: 'edit' },
    expectedFile: 'src/a.ts',
    confirmedBy: (_method, phase) => (phase === 'startup' ? 'not-started' : 'server-ack'),
    closed: async () => undefined,
  },
];




/** Invariants every stream must satisfy, whatever happened. */
function assertWellFormed(events: AgentEvent[]): void {
  const terminals = events.filter((event) => event.t === 'turn.finished');
  expect(terminals).toHaveLength(1);
  expect(events.at(-1)?.t).toBe('turn.finished');
  const started = new Set<string>();
  const finished = new Set<string>();
  for (const event of events) {
    if (event.t === 'tool.started') started.add(event.callId);
    if (event.t === 'tool.finished') {
      expect(started.has(event.callId)).toBe(true);
      expect(finished.has(event.callId)).toBe(false);
      finished.add(event.callId);
    }
    if (event.t === 'cancel.receipt') {
      expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'interrupted' });
    }
  }
}


describe.each(drivers)('runner conformance: $id', (driver) => {
  it('start → events → idle success, with session.started first', { timeout: 20_000 }, async () => {
    const h = driver.harness('success');
    const session = await h.runner.start(startInput(new AbortController().signal, h.runEnv));
    const events = await collect(session);
    assertWellFormed(events);
    expect(events[0]?.t).toBe('session.started');
    expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'idle' });
    expect(events.filter((event) => event.t === 'message.delta').length).toBeGreaterThan(0);
    expect(events.some((event) => event.t === 'error')).toBe(false);
    await driver.closed(session);
    expect(isAlive(h.invocation()?.pid)).toBe(false);
    await expect(collect(session)).rejects.toThrow('only be consumed once');
  });

  it('reports the tool-call lifecycle and the changed file', { timeout: 20_000 }, async () => {
    const h = driver.harness('success');
    const events = await collect(await h.runner.start(startInput(new AbortController().signal, h.runEnv)));
    const started = events.findIndex((event) => event.t === 'tool.started' && event.callId === driver.expectedTool.callId);
    const finished = events.findIndex((event) => event.t === 'tool.finished' && event.callId === driver.expectedTool.callId);
    expect(started).toBeGreaterThan(-1);
    expect(finished).toBeGreaterThan(started);
    expect(events[started]).toMatchObject({ name: driver.expectedTool.name });
    expect(events[finished]).toMatchObject({ name: driver.expectedTool.name, ok: true });
    expect(events).toContainEqual(expect.objectContaining({ t: 'file.changed', path: driver.expectedFile }));
  });

  it('accounts usage exactly once (reduceUsage over the stream equals the recorded totals)', { timeout: 20_000 }, async () => {
    const h = driver.harness('success');
    const events = await collect(await h.runner.start(startInput(new AbortController().signal, h.runEnv)));
    expect(reduceUsage(events).usage).toEqual(driver.expectedUsage);
  });

  it('treats EOF without a terminal event as a failure, never success', { timeout: 20_000 }, async () => {
    const h = driver.harness('eof');
    const session = await h.runner.start(startInput(new AbortController().signal, h.runEnv));
    const events = await collect(session);
    assertWellFormed(events);
    expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'error' });
    expect(events).toContainEqual(expect.objectContaining({ t: 'error', retryable: false }));
    await driver.closed(session);
  });

  it('tolerates and reports malformed and unknown lines, then completes', { timeout: 20_000 }, async () => {
    const h = driver.harness('malformed');
    const events = await collect(await h.runner.start(startInput(new AbortController().signal, h.runEnv)));
    assertWellFormed(events);
    expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'idle' });
    const diagnostics = events.filter((event) => event.t === 'diagnostic');
    expect(diagnostics.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics.some((event) => event.t === 'diagnostic' && event.code === 'unknown_event')).toBe(true);
    expect(diagnostics.some((event) => event.t === 'diagnostic' && (event.code === 'malformed_line' || event.code === 'invalid_event'))).toBe(true);
    expect(reduceUsage(events).usage).toEqual(driver.expectedUsage);
  });

  it('resumes a saved session by id with a continuation prompt', { timeout: 20_000 }, async () => {
    const h = driver.harness('resume');
    const session = await h.runner.resume(driver.resumeId, { worktreePath: worktree, signal: new AbortController().signal, env: h.runEnv });
    const events = await collect(session);
    assertWellFormed(events);
    expect(events[0]).toMatchObject({ t: 'session.started', externalId: driver.resumeId });
    expect(session.externalId).toBe(driver.resumeId);
    expect(events.filter((event) => event.t === 'session.started')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'idle' });
    const invocation = h.invocation();
    // Every runner continues the saved session; none replays the original task.
    expect(invocation?.prompt).toContain('Continue the interrupted task');
    expect(invocation?.prompt).not.toContain('Fix the failing test.');
    if (driver.id === 'claude-code') {
      expect(invocation?.argv).toEqual(expect.arrayContaining(['--resume', driver.resumeId]));
      expect(invocation?.argv).not.toContain('--session-id');
      expect(invocation?.prompt).toContain('Continue the interrupted task');
    }
    if (driver.id === 'codex') {
      expect(invocation?.argv?.slice(-2)).toEqual(['resume', driver.resumeId]);
      expect(invocation?.prompt).toContain('Continue the interrupted task');
    }
  });

  it('fails closed when no sandbox is available: nothing is spawned or prompted', async () => {
    const h = driver.harness('success', { unavailable: true });
    await expect(h.runner.start(startInput(new AbortController().signal, h.runEnv))).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    expect(h.spawns()).toBe(0);
    expect(h.started()).toBe(false);
  });

  it('does not start a run whose signal is already aborted', async () => {
    const h = driver.harness('success');
    const controller = new AbortController();
    controller.abort();
    const events = await collect(await h.runner.start(startInput(controller.signal, h.runEnv)));
    expect(events.slice(-2)).toEqual([
      { t: 'cancel.receipt', via: 'signal', confirmedBy: 'not-started' },
      { t: 'turn.finished', turn: 0, reason: 'interrupted' },
    ]);
    expect(h.started()).toBe(false);
    expect(h.spawns()).toBe(0);
  });

  describe.each<Phase>(['startup', 'streaming', 'tool'])('cancel during %s', (phase) => {
    it.each<Method>(['interrupt', 'abort', 'signal'])('via %s ends with a confirmed receipt', { timeout: 20_000 }, async (method) => {
      const h = driver.harness(phase);
      const controller = new AbortController();
      const session = await h.runner.start(startInput(controller.signal, h.runEnv));
      const iterator = session.events[Symbol.asyncIterator]();
      const events: AgentEvent[] = [];
      if (phase === 'streaming') await readUntil(iterator, events, (event) => event.t === 'message.delta');
      if (phase === 'tool') await readUntil(iterator, events, (event) => event.t === 'tool.started');
      if (method === 'signal') controller.abort();
      else await session[method]();
      await drain(iterator, events);
      assertWellFormed(events);
      const via = method === 'signal' ? 'signal' : method;
      expect(events.at(-2)).toMatchObject({ t: 'cancel.receipt', via, confirmedBy: driver.confirmedBy(method, phase) });
      expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'interrupted' });
      await driver.closed(session);
      expect(isAlive(h.invocation()?.pid)).toBe(false);
    });
  });

  it('treats cancellation after the terminal event as a no-op', { timeout: 20_000 }, async () => {
    const h = driver.harness('success');
    const session = await h.runner.start(startInput(new AbortController().signal, h.runEnv));
    const events = await collect(session);
    await session.interrupt();
    await session.abort();
    expect(events.at(-1)).toMatchObject({ t: 'turn.finished', reason: 'idle' });
    expect(events.some((event) => event.t === 'cancel.receipt')).toBe(false);
  });

  it('never passes the sidecar’s secret-named variables to the runtime', { timeout: 20_000 }, async () => {
    if (driver.id === 'opencode') {
      // OpenCode's child is the per-attempt server; its env comes from this builder (W09a).
      const env = buildSandboxAgentEnv({
        source: { ...process.env, ...PLANTED_SECRETS },
        path: '/usr/bin:/bin', home: '/h', tmp: '/t', xdgConfigHome: '/h/c', xdgDataHome: '/h/d', xdgStateHome: '/h/s', xdgCacheHome: '/h/x',
        proxyUrl: 'http://127.0.0.1:1', shell: '/bin/sh',
      });
      for (const name of Object.keys(PLANTED_SECRETS)) expect(env[name]).toBeUndefined();
      return;
    }
    const h = driver.harness('success');
    await collect(await h.runner.start(startInput(new AbortController().signal, h.runEnv)));
    const env = h.invocation()?.env ?? {};
    for (const [name, value] of Object.entries(PLANTED_SECRETS)) {
      expect(Object.values(env)).not.toContain(value);
      if (name !== 'ANTHROPIC_API_KEY') expect(env[name]).toBeUndefined();
    }
    // The only credential present is the one passed explicitly for this run.
    const allowedSecretNames = driver.id === 'claude-code' ? ['ANTHROPIC_API_KEY'] : ['CODEX_API_KEY'];
    for (const name of Object.keys(env)) {
      if (isSecretLikeEnvName(name)) expect(allowedSecretNames).toContain(name);
    }
    if (driver.id === 'claude-code') expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-per-run-FIXTURE');
    else expect(env.CODEX_API_KEY).toBe('sk-per-run-FIXTURE');
    expect(env.HOME?.startsWith(join(root, 'sandbox'))).toBe(true);
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});
