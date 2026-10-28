import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRunner, StartInput } from '@openlinear/execution-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { synthesizeRecording } from '../fakes/recordings';
import { parseManifest } from '../manifest/schema';
import { type BaseRepo, cloneForTrial, loadHoldout, materializeBaseRepo } from '../tasks/holdout';
import { SAMPLE_TASKS, writeSampleHoldout } from '../tasks/samples';
import type { LoadedTask } from '../tasks/types';
import { testConfiguration, testManifestInput } from '../testing/fixtures';
import { RecordedTrajectorySchema, TRAJECTORY_SCHEMA_VERSION } from '../trajectory/types';
import { git } from '../util/git';
import { loadRunnerAdapter } from './adapter-loader';
import { OpenLinearAdapterRunner } from './openlinear-adapter';
import { bareOriginHarvester, bareOriginPreparer, OpenLinearApiRunner } from './openlinear-api';
import { ReplayAgentRunner } from './replay-agent-runner';
import type { TrialContext } from './types';
import { capturePatch } from './workspace';

let root: string;
let tasks: LoadedTask[];
const bases = new Map<string, BaseRepo>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'evals-ol-'));
  await writeSampleHoldout(join(root, 'holdout'));
  tasks = (await loadHoldout(join(root, 'holdout'))).tasks;
  for (const task of tasks) bases.set(task.spec.id, await materializeBaseRepo(task, join(root, 'work')));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const source = (id: string) => {
  const s = SAMPLE_TASKS.find((t) => t.id === id);
  if (!s) throw new Error(id);
  return s;
};

async function context(taskId: string, name: string, agentTimeoutMs = 5000): Promise<TrialContext> {
  const task = tasks.find((t) => t.spec.id === taskId) as LoadedTask;
  const base = bases.get(taskId) as BaseRepo;
  const scratch = join(root, 'trials', name);
  await mkdir(scratch, { recursive: true });
  await cloneForTrial(base, join(scratch, 'worktree'));
  return {
    trialId: name,
    attempt: 1,
    repeat: 1,
    task,
    configuration: testConfiguration('ol', { harness: 'openlinear', transport: 'adapter', runner: { id: 'opencode', binaryVersion: 'replay-1', binarySha256: null, sdkVersion: null, mode: 'fake' } }),
    manifest: parseManifest(testManifestInput({ budgets: { agentTimeoutMs, verifierTimeoutMs: 30_000, maxTurns: 30, maxUsdPerTask: 10 } })),
    worktree: join(scratch, 'worktree'),
    baseSha: base.baseSha,
    scratchDir: scratch,
    prompt: task.instruction,
    systemContract: 'eval contract',
    sealed: task.sealed,
    signal: new AbortController().signal,
  };
}

describe('OpenLinearAdapterRunner over the execution-core AgentRunner contract (replay)', () => {
  it('passes contract, prompt and budgets in StartInput and applies the recorded edits', async () => {
    let seen: StartInput | null = null;
    const replay = new ReplayAgentRunner({
      id: 'opencode',
      pick: (input) => {
        seen = input;
        return synthesizeRecording({ task: source('lru-refresh-on-get'), kind: 'fix', runner: 'opencode', model: 'snap', format: null, seedLabel: 'a' });
      },
    });
    const ctx = await context('lru-refresh-on-get', 'ol-fix');
    const result = await new OpenLinearAdapterRunner({ runner: replay, fake: true }).run(ctx);
    expect(result).toMatchObject({ termination: 'completed', observedModel: 'snap', observedRunnerVersion: 'replay-1' });
    expect(seen).toMatchObject({ runId: 'ol-fix', systemContract: 'eval contract', worktreePath: ctx.worktree, budgets: { wallClockMs: 5000, maxTurns: 30, maxUsd: 10 }, permissions: { default: 'allow' } });
    expect(result.usage).toMatchObject({ tokenBasis: 'provider-reported', semantics: 'cache-disjoint', reportedCostBasis: 'runner-reported' });
    expect(result.firstActionMs).not.toBeNull();
    expect(await capturePatch(ctx.worktree, ctx.baseSha)).toContain('if (!this.map.has(key)) return undefined;');
  });

  it('classifies start failures and provider errors as infra, with unknown usage', async () => {
    const failing = new ReplayAgentRunner({
      id: 'opencode',
      pick: () => RecordedTrajectorySchema.parse({ schemaVersion: TRAJECTORY_SCHEMA_VERSION, id: 'x', taskId: 'x', runner: 'opencode', source: 'synthetic', behavior: { startError: { code: 'SANDBOX_UNAVAILABLE', message: 'no verified sandbox' } } }),
    });
    const start = await new OpenLinearAdapterRunner({ runner: failing, fake: true }).run(await context('sum-range-inclusive', 'ol-start'));
    expect(start).toMatchObject({ termination: 'infra', terminationDetail: 'start failed (SANDBOX_UNAVAILABLE)' });
    expect(start.usage.tokens).toBeNull();
    const overloaded = new ReplayAgentRunner({ id: 'opencode', pick: () => synthesizeRecording({ task: source('sum-range-inclusive'), kind: 'infra', runner: 'opencode', model: 'm', format: null, seedLabel: 'b' }) });
    const provider = await new OpenLinearAdapterRunner({ runner: overloaded, fake: true }).run(await context('sum-range-inclusive', 'ol-529'));
    expect(provider.termination).toBe('infra');
    expect(provider.usage.tokens).toBeNull();
  });

  it('stops a hung run at the wall-clock budget with a confirmed cancel receipt', async () => {
    const hung = new ReplayAgentRunner({ id: 'opencode', pick: () => synthesizeRecording({ task: source('slugify-collapse'), kind: 'timeout', runner: 'opencode', model: 'm', format: null, seedLabel: 'c' }) });
    const started = Date.now();
    const result = await new OpenLinearAdapterRunner({ runner: hung, fake: true, stopGraceMs: 200 }).run(await context('slugify-collapse', 'ol-hang', 400));
    expect(result.termination).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.events.map((e) => e.event.t)).toContain('cancel.receipt');
  });

  it('denies permission requests and treats an unconfirmed stop as infra (artifacts untrustworthy)', async () => {
    const replies: string[] = [];
    const runner: AgentRunner = {
      id: 'opencode',
      capabilities: { streamingDeltas: true, reasoningDeltas: false, permissionReply: true, interrupt: true, compact: false, revert: false, fork: false, cacheSplitUsage: false },
      healthCheck: async () => ({ ok: true }),
      listModels: async () => [],
      resume: async () => {
        throw new Error('no');
      },
      start: async () => ({
        externalId: 'stubborn',
        interrupt: async () => undefined,
        abort: async () => undefined,
        replyPermission: async (id, decision) => {
          replies.push(`${id}:${decision}`);
        },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { t: 'permission.requested', id: 'p1', tool: 'bash', detail: 'rm -rf' } as const;
            await new Promise(() => undefined);
          },
        },
      }),
    };
    const result = await new OpenLinearAdapterRunner({ runner, fake: true, stopGraceMs: 100 }).run(await context('sum-range-inclusive', 'ol-stubborn', 200));
    expect(replies).toEqual(['p1:deny']);
    expect(result.termination).toBe('infra');
    expect(result.terminationDetail).toContain('cancel_unconfirmed');
  });
});

describe('loadRunnerAdapter', () => {
  it('loads a module exporting createEvalRunner / pickRunner and shape-checks it', async () => {
    const dir = join(root, 'adapters');
    await mkdir(dir, { recursive: true });
    const good = join(dir, 'good.mjs');
    await writeFile(good, `export function pickRunner({ taskAgent }) { return { id: taskAgent, capabilities: {}, start() {}, resume() {}, healthCheck() {}, listModels() {} }; }\n`);
    const runner = await loadRunnerAdapter(good, 'codex');
    expect(runner.id).toBe('codex');
    const bad = join(dir, 'bad.mjs');
    await writeFile(bad, 'export function createEvalRunner() { return { id: "codex" }; }\n');
    await expect(loadRunnerAdapter(bad, 'codex')).rejects.toThrow('did not return an execution-core AgentRunner');
    const none = join(dir, 'none.mjs');
    await writeFile(none, 'export const x = 1;\n');
    await expect(loadRunnerAdapter(none, 'codex')).rejects.toThrow('neither createEvalRunner nor pickRunner');
  });
});

describe('OpenLinearApiRunner (full path) against a loopback stand-in for API + sidecar', () => {
  it('creates, executes, polls, harvests the published branch and reports usage as unknown', async () => {
    const origin = join(root, 'origin.git');
    await git(root, ['init', '--quiet', '--bare', origin]);
    const ctx = await context('semver-numeric-compare', 'api-1');
    const calls: string[] = [];
    let polls = 0;
    const server = http.createServer(async (req, res) => {
      calls.push(`${req.method} ${req.url} ${req.headers.authorization === 'Bearer ol_pat_test' ? 'auth' : 'noauth'}`);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && req.url === '/api/tasks') return json(201, { id: 'task-1', status: 'todo' });
      if (req.method === 'POST' && req.url === '/api/tasks/task-1/execute') {
        // Simulate the sidecar: work on a branch and push it to the origin.
        const work = join(root, 'sidecar-work');
        await git(root, ['clone', '--quiet', origin, work]);
        await writeFile(join(work, 'src', 'semver.mjs'), source('semver-numeric-compare').fixed['src/semver.mjs'] ?? '');
        await git(work, ['checkout', '--quiet', '-b', 'openlinear/task-1']);
        await git(work, ['commit', '--quiet', '-am', 'fix']);
        await git(work, ['push', '--quiet', 'origin', 'openlinear/task-1']);
        return json(200, { message: 'Task execution started' });
      }
      if (req.url === '/api/tasks/task-1/running') {
        polls += 1;
        return json(200, { running: polls < 2 });
      }
      if (req.url === '/api/tasks/task-1/logs') return json(200, { logs: [{ type: 'agent', message: 'edited src/semver.mjs' }] });
      if (req.method === 'GET' && req.url === '/api/tasks/task-1') return json(200, { data: { id: 'task-1', status: 'done' } });
      return json(404, { error: 'not found' });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const url = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
    try {
      const runner = new OpenLinearApiRunner({
        apiUrl: url,
        sidecarUrl: url,
        token: () => 'ol_pat_test',
        projectId: '00000000-0000-0000-0000-000000000001',
        prepareOrigin: bareOriginPreparer(origin),
        harvest: bareOriginHarvester(origin),
        pollIntervalMs: 20,
      });
      expect(runner.plan(ctx)[1]).toContain('/api/tasks/:id/execute');
      const result = await runner.run(ctx);
      expect(result).toMatchObject({ termination: 'completed', terminationDetail: 'done (publication confirmed)' });
      expect(result.usage).toMatchObject({ tokens: null, tokenBasis: 'unknown' });
      expect(calls.every((c) => c.endsWith(' auth'))).toBe(true);
      expect(calls.map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
        'POST /api/tasks',
        'POST /api/tasks/task-1/execute',
        'GET /api/tasks/task-1/running',
        'GET /api/tasks/task-1/running',
        'GET /api/tasks/task-1/logs',
        'GET /api/tasks/task-1',
      ]);
      expect(await capturePatch(ctx.worktree, ctx.baseSha)).toContain('right[i]');
      expect(result.logs.join('\n')).not.toContain('ol_pat_test');
    } finally {
      server.close();
    }
  });

  it('maps an execute refusal (e.g. SANDBOX_UNAVAILABLE) to infra', async () => {
    const ctx = await context('sum-range-inclusive', 'api-2');
    const fetchImpl: typeof fetch = async (input) => {
      const target = String(input);
      if (target.endsWith('/api/tasks')) return new Response(JSON.stringify({ id: 't' }), { status: 201 });
      return new Response(JSON.stringify({ error: 'no sandbox', code: 'SANDBOX_UNAVAILABLE' }), { status: 503 });
    };
    const runner = new OpenLinearApiRunner({ apiUrl: 'http://api.invalid', sidecarUrl: 'http://sidecar.invalid', token: () => 't', projectId: 'p', prepareOrigin: async () => undefined, harvest: async () => ({ applied: false, detail: 'none' }), fetchImpl });
    expect(await runner.run(ctx)).toMatchObject({ termination: 'infra', terminationDetail: 'execute refused (SANDBOX_UNAVAILABLE)' });
  });
});
