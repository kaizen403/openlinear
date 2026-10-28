import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { platformProvider } from '../sandbox/provider';
import type { SandboxProvider } from '../sandbox/types';
import { resolveClaudeBinary } from './claude-code/binary';
import { resolveCodexBinary } from './codex/exec';
import { launchRunnerProcess, resetRunnerGcForTests, type RunnerProcess, type RunnerProcessSpec } from './shared/sandboxed-process';

/**
 * W07 runner corpus on the real OS boundary (macOS Seatbelt locally, Linux
 * bubblewrap in the sandbox CI job). Uses a fabricated HOME with FAKE login
 * files; the real home directory is never read. Skipped without a usable
 * provider unless OPENLINEAR_SANDBOX_CORPUS_REQUIRED=1.
 *
 * OPENLINEAR_RUNNERS_REAL_BINARIES=1 additionally runs the user's installed
 * `claude` / vendored `codex` under the sandbox with version and auth-status
 * commands only (no model request).
 */

const provider: SandboxProvider | null = platformProvider();
const required = process.env.OPENLINEAR_SANDBOX_CORPUS_REQUIRED === '1';
const detectedOk = provider ? (await provider.detect()).ok : false;
const describeCorpus = provider !== null && (detectedOk || required) ? describe : describe.skip;
const describeReal = provider !== null && detectedOk && process.env.OPENLINEAR_RUNNERS_REAL_BINARIES === '1' ? describe : describe.skip;

let root = '';
let worktree = '';
let fakeHome = '';

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-runner-corpus-')));
  worktree = join(root, 'worktree');
  fakeHome = join(root, 'home');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(fakeHome, '.claude', 'projects', 'other-project'), { recursive: true });
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
  writeFileSync(join(fakeHome, '.claude', '.credentials.json'), 'OPENLINEAR-FAKE-CLAUDE-LOGIN\n', { mode: 0o600 });
  writeFileSync(join(fakeHome, '.claude', 'projects', 'other-project', 'transcript.jsonl'), 'OPENLINEAR-FAKE-OTHER-TRANSCRIPT\n');
  writeFileSync(join(fakeHome, '.claude', 'settings.json'), '{"hooks":{}}\n');
  writeFileSync(join(fakeHome, '.ssh', 'id_ed25519'), 'OPENLINEAR-FAKE-SSH-KEY\n');
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function sidecarEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: fakeHome,
    LANG: 'en_US.UTF-8',
    OPENLINEAR_SANDBOX_DIR: join(root, 'sandbox'),
    OPENLINEAR_SANDBOX_REGISTRIES: '0',
    DATABASE_URL: 'postgres://u:OPENLINEAR-FAKE-DB@x/y',
    JWT_SECRET: 'OPENLINEAR-FAKE-JWT',
    GITHUB_TOKEN: 'ghp_OPENLINEARFAKEFAKEFAKEFAKE',
  };
}

async function run(spec: RunnerProcessSpec, env = sidecarEnv()): Promise<{ stdout: string; stderr: string; code: number | null; proc: RunnerProcess }> {
  resetRunnerGcForTests();
  const proc = await launchRunnerProcess(spec, { env });
  proc.stdin.end();
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const exit = await proc.exited;
  await proc.dispose();
  return { stdout, stderr, code: exit.code, proc };
}

const PROBE = [
  'echo "login:$(cat "$CLAUDE_CONFIG_DIR/.credentials.json" 2>/dev/null || echo DENIED)"',
  `echo "transcript:$(cat '${'$FAKE_HOME'}/.claude/projects/other-project/transcript.jsonl' 2>/dev/null || echo DENIED)"`,
  `echo "settings:$(cat '${'$FAKE_HOME'}/.claude/settings.json' 2>/dev/null || echo DENIED)"`,
  `echo "ssh:$(cat '${'$FAKE_HOME'}/.ssh/id_ed25519' 2>/dev/null || echo DENIED)"`,
  'if (echo tampered >> "$CLAUDE_CONFIG_DIR/.credentials.json") 2>/dev/null; then echo "write-login:ALLOWED"; else echo "write-login:DENIED"; fi',
  `if (echo '{"hooks":{"x":1}}' > '${'$FAKE_HOME'}/.claude/settings.json') 2>/dev/null; then echo "write-settings:ALLOWED"; else echo "write-settings:DENIED"; fi`,
  'if (echo ok > "$CLAUDE_CONFIG_DIR/session.jsonl") 2>/dev/null; then echo "write-config:ALLOWED"; else echo "write-config:DENIED"; fi',
  'echo "home:$HOME"',
  'env | grep -c OPENLINEAR-FAKE || true',
];

describeCorpus(`runner launch on the real OS boundary (${provider?.id ?? 'none'})`, () => {
  it('exposes exactly the login file, read-only, and nothing else of the real ~/.claude', async () => {
    const script = PROBE.join('\n').replaceAll('$FAKE_HOME', fakeHome);
    const result = await run({
      runner: 'claude-code',
      worktree,
      binary: '/bin/sh',
      argv: () => ['-c', script],
      enforceEnv: (dirs) => ({ CLAUDE_CONFIG_DIR: dirs.runtime }),
      hostEnv: () => ({ PATH: '/usr/bin:/bin' }),
      loginFiles: [{ source: join(fakeHome, '.claude', '.credentials.json'), linkName: '.credentials.json' }],
      egressProviders: ['anthropic'],
    });
    const lines = result.stdout.trim().split('\n');
    expect(lines).toContain('login:OPENLINEAR-FAKE-CLAUDE-LOGIN');
    expect(lines).toContain('transcript:DENIED');
    expect(lines).toContain('settings:DENIED');
    expect(lines).toContain('ssh:DENIED');
    expect(lines).toContain('write-login:DENIED');
    expect(lines).toContain('write-settings:DENIED');
    expect(lines).toContain('write-config:ALLOWED');
    expect(lines.find((line) => line.startsWith('home:'))).toBe(`home:${join(root, 'sandbox', 'runners', 'claude-code', result.proc.metadata.attemptKey, 'home')}`);
    // The planted sidecar secrets are absent from the child's environment.
    expect(lines.at(-1)).toBe('0');
    expect(result.proc.metadata.loginFileAllowances).toEqual([realpathSync.native(join(fakeHome, '.claude', '.credentials.json'))]);
  }, 60_000);

  it('blocks direct egress and allows only the runner’s provider hosts through the proxy', async () => {
    const result = await run({
      runner: 'codex',
      worktree,
      binary: '/usr/bin/curl',
      argv: () => ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', 'https://example.com/'],
      enforceEnv: () => ({}),
      hostEnv: () => ({ PATH: '/usr/bin:/bin' }),
      egressProviders: ['openai'],
    });
    // The proxy answers CONNECT to a non-allowlisted host with 403.
    expect(result.stdout).not.toBe('200');
    expect(result.proc.metadata.egressAllowedHosts).toEqual(['api.openai.com', 'auth.openai.com', 'chatgpt.com']);
  }, 60_000);
});

describeReal('installed runtimes under the sandbox (version and auth status only; no inference)', () => {
  it('runs the user’s claude: version works, the Keychain login is not reachable', async () => {
    const binary = resolveClaudeBinary(process.env);
    expect(binary).not.toBeNull();
    const spec = (args: string[]): RunnerProcessSpec => ({
      runner: 'claude-code',
      worktree,
      binary: binary?.path ?? '',
      argv: () => args,
      enforceEnv: (dirs) => ({ CLAUDE_CONFIG_DIR: dirs.runtime, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }),
      hostEnv: () => ({}),
      readRoots: binary?.readRoot ? [binary.readRoot] : [],
      egressProviders: ['anthropic'],
    });
    const env = { ...sidecarEnv(), HOME: homedir() };
    const version = await run(spec(['--version']), env);
    console.info(`[runners corpus] sandboxed claude --version: code=${version.code} stdout=${version.stdout.trim()} stderr=${version.stderr.trim().slice(0, 300)}`);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/\d+\.\d+\.\d+ \(Claude Code\)/);
    const status = await run(spec(['auth', 'status', '--json']), env);
    const parsed = JSON.parse(status.stdout || '{}') as { loggedIn?: boolean; authMethod?: string };
    console.info(`[runners corpus] sandboxed claude auth status: code=${status.code} loggedIn=${String(parsed.loggedIn)} authMethod=${String(parsed.authMethod)}`);
    if (process.platform === 'darwin') expect(parsed.loggedIn).toBe(false);
  }, 120_000);

  it('runs the vendored codex: version works under the sandbox', async () => {
    const binary = resolveCodexBinary(process.env);
    const result = await run({
      runner: 'codex',
      worktree,
      binary: binary.path,
      argv: () => ['--version'],
      enforceEnv: (dirs) => ({ CODEX_HOME: dirs.runtime }),
      hostEnv: () => ({}),
      readRoots: binary.readRoot ? [binary.readRoot] : [],
      egressProviders: ['openai'],
    }, { ...sidecarEnv(), HOME: homedir() });
    console.info(`[runners corpus] sandboxed codex --version: code=${result.code} stdout=${result.stdout.trim()} stderr=${result.stderr.trim().slice(0, 300)}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('codex-cli 0.164.0');
  }, 120_000);
});
