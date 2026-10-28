import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CapabilityReport, SandboxPolicy, SandboxProvider, SpawnSpec, WrappedSpawn } from '../../sandbox/types';

/**
 * Test-only fake runtime binaries. Each is a small Node script (shebang to
 * this Node) that replays a recorded event stream, honours the same stdin
 * protocol as the real CLI (Claude stream-json input incl. control requests;
 * Codex prompt-on-stdin) and logs its argv/env/stdin to a JSONL file so the
 * conformance suite can assert what the adapter launched. No model is ever
 * contacted.
 */

export type FakeStep =
  | { line: unknown }
  | { raw: string }
  | { stderr: string }
  | { sleep: number }
  | { hang: true }
  | { exit: number }
  /** Claude only: emit a can_use_tool request and wait for the host's answer. */
  | { permission: { requestId: string; toolName: string; toolUseId: string; input: Record<string, unknown> } }
  /** W07a: write a file relative to the CLI's cwd (the worktree), like an agent edit. */
  | { write: { path: string; content: string } };

export interface FakeScenario {
  steps: FakeStep[];
  /** Claude: how to answer an interrupt control_request. */
  interrupt?: 'ack' | 'ignore';
  /** What SIGTERM does: exit 143 (default) or nothing (forces SIGKILL). */
  onSigterm?: 'exit' | 'ignore';
  /** Codex: exit 0 after the last step (default true). */
  exitAtEnd?: boolean;
  /** Claude `auth status --json` output. */
  authStatus?: Record<string, unknown>;
  /** `--version` output. */
  version?: string;
  /** Codex `login status` output. */
  loginStatus?: string;
}

export interface FakeInvocation {
  event: string;
  argv?: string[];
  env?: Record<string, string>;
  cwd?: string;
  pid?: number;
  prompt?: string;
  msg?: unknown;
}

const COMMON = String.raw`
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// The scenario lives next to the invoked path (a per-test symlink to this
// shared script), so the executable itself is written once and never changes.
const SELF = process.argv[1];
const SCENARIO = JSON.parse(readFileSync(SELF + '.scenario.json', 'utf8'));
const LOG = SELF + '.log.jsonl';
const record = (entry) => appendFileSync(LOG, JSON.stringify(entry) + '\n');
const writeStep = (step) => { const target = join(process.cwd(), step.write.path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, step.write.content); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keepAlive = setInterval(() => undefined, 1 << 30);
process.on('SIGTERM', () => {
  record({ event: 'sigterm' });
  if ((SCENARIO.onSigterm ?? 'exit') === 'exit') process.exit(143);
});
process.on('SIGINT', () => { record({ event: 'sigint' }); });
`;

const CLAUDE = String.raw`
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write(SCENARIO.version ?? '2.1.310 (Claude Code)\n'); process.exit(0); }
if (argv[0] === 'auth') {
  process.stdout.write(JSON.stringify(SCENARIO.authStatus ?? { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'person@example.invalid', orgName: 'Fixture Org' }));
  process.exit(0);
}
const flag = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
const session = flag('--resume') ?? flag('--session-id') ?? 'no-session';
let stopped = false;
let started = false;
const waiters = new Map();
const out = (value) => { if (!stopped) process.stdout.write(JSON.stringify(value).split('$SESSION').join(session) + '\n'); };
async function run() {
  for (const step of SCENARIO.steps) {
    if (stopped) return;
    if ('line' in step) out(step.line);
    else if ('raw' in step) process.stdout.write(step.raw + '\n');
    else if ('stderr' in step) process.stderr.write(step.stderr + '\n');
    else if ('sleep' in step) await sleep(step.sleep);
    else if ('hang' in step) await new Promise(() => undefined);
    else if ('exit' in step) process.exit(step.exit);
    else if ('write' in step) writeStep(step);
    else if ('permission' in step) {
      const p = step.permission;
      const answer = new Promise((resolve) => waiters.set(p.requestId, resolve));
      out({ type: 'control_request', request_id: p.requestId, request: { subtype: 'can_use_tool', tool_name: p.toolName, input: p.input, tool_use_id: p.toolUseId } });
      const reply = await answer;
      const allowed = reply?.response?.behavior === 'allow';
      out({ type: 'user', parent_tool_use_id: null, session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.toolUseId, is_error: !allowed, content: allowed ? 'ran' : 'denied' }] } });
    }
  }
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const i = buffer.indexOf('\n');
    if (i === -1) break;
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    record({ event: 'input', msg });
    if (msg.type === 'user' && !started) {
      started = true;
      record({ event: 'start', argv, env: process.env, cwd: process.cwd(), pid: process.pid, prompt: msg.message?.content?.[0]?.text });
      void run();
    } else if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
      if ((SCENARIO.interrupt ?? 'ack') === 'ack') {
        out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', session_id: session, num_turns: 1, duration_ms: 1, duration_api_ms: 1, stop_reason: null, total_cost_usd: 0.001, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: {}, permission_denials: [], errors: ['interrupted'] });
        stopped = true;
      }
    } else if (msg.type === 'control_response') {
      const waiter = waiters.get(msg.response?.request_id);
      if (waiter) { waiters.delete(msg.response.request_id); waiter(msg.response); }
    }
  }
});
process.stdin.on('end', () => { record({ event: 'stdin-end' }); clearInterval(keepAlive); setTimeout(() => process.exit(0), 5); });
`;

const CODEX = String.raw`
const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write(SCENARIO.version ?? 'codex-cli 0.164.0\n'); process.exit(0); }
if (argv[0] === 'login') { process.stdout.write((SCENARIO.loginStatus ?? 'Logged in using ChatGPT') + '\n'); process.exit(0); }
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', async () => {
  record({ event: 'start', argv, env: process.env, cwd: process.cwd(), pid: process.pid, prompt });
  for (const step of SCENARIO.steps) {
    if ('line' in step) process.stdout.write(JSON.stringify(step.line) + '\n');
    else if ('raw' in step) process.stdout.write(step.raw + '\n');
    else if ('stderr' in step) process.stderr.write(step.stderr + '\n');
    else if ('sleep' in step) await sleep(step.sleep);
    else if ('hang' in step) await new Promise(() => undefined);
    else if ('exit' in step) process.exit(step.exit);
    else if ('write' in step) writeStep(step);
  }
  if (SCENARIO.exitAtEnd !== false) { clearInterval(keepAlive); process.exit(0); }
});
`;

/**
 * One static executable per runtime kind and directory; each scenario is a
 * fresh symlink to it plus a `.scenario.json` data file. Writing a new
 * executable per test made every exec a first-exec of a new file, which macOS
 * assesses (~300 ms each locally; multi-second stalls were observed during a
 * network outage). Symlinks to an already-executed file avoid that entirely.
 */
const shared = new Map<string, string>();

function sharedScript(dir: string, kind: 'claude' | 'codex', body: string): string {
  const key = `${dir}\0${kind}`;
  const existing = shared.get(key);
  if (existing && existsSync(existing)) return existing;
  const path = join(dir, `fake-${kind}-cli.mjs`);
  writeFileSync(path, `#!${process.execPath}\n${COMMON}\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  shared.set(key, path);
  return path;
}

function scenarioLink(dir: string, name: string, scenario: FakeScenario, script: string): { binary: string; log: string } {
  const binary = join(dir, name);
  writeFileSync(`${binary}.scenario.json`, JSON.stringify(scenario));
  symlinkSync(script, binary);
  return { binary, log: `${binary}.log.jsonl` };
}

export function writeFakeClaude(dir: string, scenario: FakeScenario, name = 'claude', sharedDir = dirname(dir)): { binary: string; log: string } {
  return scenarioLink(dir, name, scenario, sharedScript(sharedDir, 'claude', CLAUDE));
}

export function writeFakeCodex(dir: string, scenario: FakeScenario, name = 'codex', sharedDir = dirname(dir)): { binary: string; log: string } {
  return scenarioLink(dir, name, scenario, sharedScript(sharedDir, 'codex', CODEX));
}

export function readInvocations(log: string): FakeInvocation[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as FakeInvocation);
}

export function fakeReport(): CapabilityReport {
  return {
    provider: 'macos-seatbelt',
    providerVersion: 'fake',
    platform: process.platform,
    available: true,
    checkedAt: new Date(0).toISOString(),
    durationMs: 0,
    enforced: { filesystem: true, env: true, network: true, process: true },
    probes: [],
    blockers: [],
    warnings: [],
    unsupported: [],
  };
}

/**
 * Pass-through provider: runs the command as-is with exactly the policy's
 * env, and records every policy it was asked to enforce. It enforces
 * nothing on the filesystem (the real boundary is covered by the corpus).
 */
export function fakeProvider(): { provider: SandboxProvider; policies: SandboxPolicy[]; specs: SpawnSpec[] } {
  const policies: SandboxPolicy[] = [];
  const specs: SpawnSpec[] = [];
  const provider: SandboxProvider = {
    id: 'macos-seatbelt',
    proxyTransport: 'tcp',
    unsupportedLimits: [],
    detect: async () => ({ ok: true, version: 'fake', blockers: [], warnings: [] }),
    preflight: async () => fakeReport(),
    wrap: async (spec: SpawnSpec, policy: SandboxPolicy): Promise<WrappedSpawn> => {
      policies.push(policy);
      specs.push(spec);
      return { command: spec.command, args: [...spec.args], cwd: spec.cwd, env: { ...policy.env }, extraFds: [], release: () => undefined };
    },
  };
  return { provider, policies, specs };
}
