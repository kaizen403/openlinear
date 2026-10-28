import { baseEnv, runCommand, type RunResult } from './proc';

/** Fixed identity and dates: the same seed content always yields the same commit SHA. */
const DETERMINISTIC_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'OpenLinear Eval',
  GIT_AUTHOR_EMAIL: 'eval@openlinear.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'OpenLinear Eval',
  GIT_COMMITTER_EMAIL: 'eval@openlinear.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

/**
 * Git with no system/global config and no hooks, so a task repository cannot
 * run code in the harness through config or hooks.
 */
export function gitEnv(): Record<string, string> {
  return baseEnv({
    ...DETERMINISTIC_IDENTITY,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: '/nonexistent-openlinear-eval-home',
  });
}

const HARDENING = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false'];

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly result: RunResult,
  ) {
    super(`git ${args.join(' ')} failed (${result.code ?? result.signal ?? result.spawnError}): ${result.stderr.trim().slice(-500)}`);
    this.name = 'GitError';
  }
}

/** `env`: extra variables on top of the hardened environment (e.g. GIT_INDEX_FILE for a private index). */
export interface GitOptions {
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export async function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<string> {
  const result = await runCommand('git', [...HARDENING, ...args], {
    cwd,
    env: { ...gitEnv(), ...options.env },
    input: options.input,
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  if (result.code !== 0) throw new GitError(args, result);
  return result.stdout;
}

export async function gitTry(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<RunResult> {
  return runCommand('git', [...HARDENING, ...args], { cwd, env: { ...gitEnv(), ...options.env }, input: options.input, timeoutMs: options.timeoutMs ?? 60_000 });
}

export async function gitVersion(): Promise<string | null> {
  const result = await runCommand('git', ['--version'], { cwd: process.cwd(), env: baseEnv(), timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  return result.stdout.trim().replace(/^git version\s+/, '');
}
