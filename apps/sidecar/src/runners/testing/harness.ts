import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, AgentSession, StartInput } from '@openlinear/execution-core';
import { SandboxUnavailableError } from '../../sandbox/errors';
import type { SandboxPolicy, SpawnSpec } from '../../sandbox/types';
import { ClaudeCodeRunner, type ClaudeCodeRunnerOptions } from '../claude-code/index';
import { CodexRunner, type CodexRunnerOptions } from '../codex/index';
import { launchRunnerProcess, resetRunnerGcForTests, type RunnerProcessSpec, type SpawnProcess } from '../shared/sandboxed-process';
import { fakeProvider, fakeReport, readInvocations, writeFakeClaude, writeFakeCodex, type FakeInvocation, type FakeScenario, type FakeStep } from './fake-cli';

/** Sidecar secrets planted in the test environment; none may reach a runtime. */
export const PLANTED_SECRETS: Record<string, string> = {
  DATABASE_URL: 'postgres://u:OPENLINEAR-FAKE-DB@x/y',
  JWT_SECRET: 'OPENLINEAR-FAKE-JWT',
  GITHUB_TOKEN: 'ghp_OPENLINEARFAKEFAKEFAKEFAKE',
  TOKEN_ENCRYPTION_KEY: 'OPENLINEAR-FAKE-ENC',
  AWS_SECRET_ACCESS_KEY: 'OPENLINEAR-FAKE-AWS',
  OPENAI_API_KEY: 'sk-sidecar-OPENLINEAR-FAKE',
  ANTHROPIC_API_KEY: 'sk-ant-sidecar-OPENLINEAR-FAKE',
  LC_SECRET_TOKEN: 'OPENLINEAR-FAKE-LC',
  OPENCODE_SERVER_PASSWORD: 'OPENLINEAR-FAKE-OC',
};

let counter = 0;

export interface HarnessOptions extends Partial<FakeScenario> {
  /** The verified provider throws SANDBOX_UNAVAILABLE. */
  unavailable?: boolean;
  /** Extra sidecar env (e.g. a trusted-host grant). */
  env?: NodeJS.ProcessEnv;
  claude?: Partial<ClaudeCodeRunnerOptions>;
  codex?: Partial<CodexRunnerOptions>;
}

export interface ProcessHarness<R> {
  runner: R;
  env: NodeJS.ProcessEnv;
  home: string;
  dir: string;
  binary: string;
  policies: SandboxPolicy[];
  specs: SpawnSpec[];
  spawns(): number;
  invocations(): FakeInvocation[];
  invocation(): FakeInvocation | undefined;
  started(): boolean;
}

function base(root: string, kind: 'claude' | 'codex', steps: FakeStep[], options: HarnessOptions) {
  counter += 1;
  const dir = join(root, `${kind}-${counter}`);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const { unavailable, env: extraEnv, claude: _claude, codex: _codex, ...scenario } = options;
  const fake = kind === 'claude' ? writeFakeClaude(dir, { steps, ...scenario }) : writeFakeCodex(dir, { steps, ...scenario });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: 'en_US.UTF-8',
    OPENLINEAR_SANDBOX_DIR: join(root, 'sandbox'),
    OPENLINEAR_SANDBOX_REGISTRIES: '0',
    ...PLANTED_SECRETS,
    ...extraEnv,
  };
  let spawnCount = 0;
  const spawnProcess: SpawnProcess = (command, args, spawnOptions) => {
    spawnCount += 1;
    return spawn(command, [...args], spawnOptions);
  };
  const { provider, policies, specs } = fakeProvider();
  resetRunnerGcForTests();
  const launch = (spec: RunnerProcessSpec) => launchRunnerProcess(spec, {
    env,
    spawnProcess,
    verifiedProvider: async () => {
      if (unavailable) throw new SandboxUnavailableError('No verified sandbox is available', ['fixture: provider unavailable']);
      return { provider, report: fakeReport() };
    },
  });
  const invocations = () => readInvocations(fake.log);
  return {
    dir,
    home,
    env,
    launch,
    binary: fake.binary,
    policies,
    specs,
    spawns: () => spawnCount,
    invocations,
    invocation: () => invocations().find((entry) => entry.event === 'start'),
    started: () => invocations().some((entry) => entry.event === 'start'),
  };
}

export function claudeHarness(root: string, steps: FakeStep[], options: HarnessOptions = {}): ProcessHarness<ClaudeCodeRunner> {
  const h = base(root, 'claude', steps, options);
  const runner = new ClaudeCodeRunner({
    env: h.env,
    resolveBinary: () => ({ path: h.binary, readRoot: null, source: 'override' }),
    launch: h.launch,
    killGraceMs: 400,
    interruptAckMs: 600,
    ...options.claude,
  });
  return { ...h, runner };
}

export function codexHarness(root: string, steps: FakeStep[], options: HarnessOptions = {}): ProcessHarness<CodexRunner> {
  const h = base(root, 'codex', steps, options);
  const runner = new CodexRunner({
    env: h.env,
    resolveBinary: () => ({ path: h.binary, pathDirs: [], readRoot: null, version: '0.164.0', source: 'override' }),
    launch: h.launch,
    killGraceMs: 400,
    ...options.codex,
  });
  return { ...h, runner };
}

export function startInput(worktree: string, overrides: Partial<StartInput> = {}): StartInput {
  return {
    runId: 'run-1',
    worktreePath: worktree,
    systemContract: 'Fixture contract: verify before finishing.',
    prompt: 'Fix the failing test.',
    model: { provider: 'anthropic', id: 'fixture-model' },
    budgets: { wallClockMs: 60_000 },
    permissions: { default: 'allow' },
    sandbox: { cwd: worktree, env: {} },
    env: {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

export async function collect(session: AgentSession): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of session.events) out.push(event);
  return out;
}

export async function drain(iterator: AsyncIterator<AgentEvent>, into: AgentEvent[]): Promise<void> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) return;
    into.push(next.value);
  }
}

export async function readUntil(iterator: AsyncIterator<AgentEvent>, into: AgentEvent[], predicate: (event: AgentEvent) => boolean): Promise<void> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error(`stream ended before the marker; saw ${into.map((event) => event.t).join(',')}`);
    into.push(next.value);
    if (predicate(next.value)) return;
  }
}

interface Closable {
  whenClosed(): Promise<void>;
}

export async function closed(session: AgentSession): Promise<void> {
  const candidate = session as AgentSession & Partial<Closable>;
  if (typeof candidate.whenClosed === 'function') await candidate.whenClosed();
}

export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
