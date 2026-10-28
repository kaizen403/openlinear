import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { displayCheckCommand, type VerificationCheckResult, type VerificationCheckSpec } from '@openlinear/execution-core';
import { parseGitStatusPorcelainZ } from '../../engine/staging-allowlist';
import { defaultAppDataRoot } from '../../journal/durable';
import { logger } from '../../lib/logger';
import { SandboxUnavailableError } from '../../sandbox/errors';
import { grantCovers, resolveSandboxMode } from '../../sandbox/mode';
import { getVerifiedProvider } from '../../sandbox/provider';
import { execGit } from '../../services/git-credentials';
import { sandboxStateRoot } from '../../sandbox/opencode-attempts';
import { appReposDir } from '../../workspace/local-worktree';
import type { RunWorkspace } from '../types';
import { createSandboxedCheckExecutor, type CheckExecution, type CheckExecutor, type CheckSandboxInfo } from '../verification/executor';

/**
 * W16a setup port of the run service: runs ONE environment setup step
 * (execution-core `setup.ts`) in the run's worktree, before the agent
 * starts, with the verification check executor:
 *
 * - the worktree is the only writable project directory (its git metadata
 *   is not readable or writable), with a private HOME/TMP/XDG root under
 *   `<sandbox state>/setup/<runId>` shared by the run's steps and removed
 *   after the last one;
 * - enforced OS sandbox (or an explicit trusted-host grant covering the
 *   worktree), exact environment, network `none` unless the step declares
 *   egress (then only its per-step proxy allowlist);
 * - wall-clock timeout, ≤ 1 MiB log artifact under
 *   `<app data>/artifacts/setup/<runId>/`, a redacted ≤ 4 KiB tail.
 *
 * Never throws for a step failure: the result says `failed`, `timed_out` or
 * `error` (sandbox unavailable, command not found, cancelled).
 */

export interface SetupStepInput {
  runId: string;
  step: VerificationCheckSpec;
  /** Position in the sealed list (log artifact name). */
  index: number;
  workspace: RunWorkspace;
  signal: AbortSignal;
}

export interface SetupStepOutcome {
  result: VerificationCheckResult;
  /** Where the step ran (null when it never reached the sandbox). */
  sandbox: CheckSandboxInfo | null;
}

/**
 * The worktree's committable changes — what publication would stage — as
 * path → git status code and content hash. Setup output must not ride along
 * as the agent's work, so the run compares this before and after setup.
 */
export type WorktreeFingerprint = ReadonlyMap<string, string>;

export interface SetupPort {
  runStep(input: SetupStepInput): Promise<SetupStepOutcome>;
  /** After the run's last step (whatever happened): remove its private HOME/TMP root. */
  cleanup(runId: string): void;
  /** Null when it cannot be read (not a repository, too many changes); the comparison is then skipped. */
  fingerprint?(worktreePath: string): Promise<WorktreeFingerprint | null>;
  /**
   * Throws SandboxUnavailableError when no step could run in this worktree
   * (no verified sandbox and no grant covering it), so execute answers 503
   * SANDBOX_UNAVAILABLE — with the desktop's sandbox guidance — instead of
   * accepting the run and failing its first step.
   */
  assertRunnable?(worktreePath: string): Promise<void>;
}

const MAX_FINGERPRINT_PATHS = 5_000;
const MAX_HASHED_BYTES = 64 * 1024 * 1024;

function contentHash(path: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (!stat.isFile()) return 'other';
    if (stat.size > MAX_HASHED_BYTES) return `large:${stat.size}:${stat.mtimeMs}`;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return 'missing';
  }
}

export async function worktreeFingerprint(worktreePath: string): Promise<WorktreeFingerprint | null> {
  let stdout: string;
  try {
    ({ stdout } = await execGit(['-C', worktreePath, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    logger.warn({ err: error }, '[Setup] could not read the worktree status');
    return null;
  }
  const entries = parseGitStatusPorcelainZ(stdout);
  if (entries.length > MAX_FINGERPRINT_PATHS) return null;
  return new Map(entries.map((entry) => [entry.path, `${entry.code}:${contentHash(join(worktreePath, entry.path))}`]));
}

/** Paths whose status or content differ between two fingerprints, sorted. */
export function changedPaths(before: WorktreeFingerprint, after: WorktreeFingerprint): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}

export interface LocalSetupDeps {
  env?: NodeJS.ProcessEnv;
  reposRoot?: () => string;
  artifactsRoot?: () => string;
  privateRoot?: () => string;
  executor?: CheckExecutor;
}

export function defaultSetupArtifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultAppDataRoot(env), 'artifacts', 'setup');
}

function toResult(step: VerificationCheckSpec, execution: Pick<CheckExecution, 'status' | 'exitCode' | 'signal' | 'durationMs' | 'timedOut' | 'log' | 'detail'>): VerificationCheckResult {
  return {
    id: step.id,
    name: step.name,
    required: step.required,
    status: execution.status,
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: Math.max(0, Math.round(execution.durationMs)),
    timedOut: execution.timedOut,
    network: step.network.mode,
    command: displayCheckCommand(step.argv),
    log: execution.log,
    detail: execution.detail,
  };
}

export function createLocalSetup(deps: LocalSetupDeps = {}): SetupPort {
  const reposRoot = deps.reposRoot ?? appReposDir;
  const artifactsRoot = deps.artifactsRoot ?? (() => defaultSetupArtifactsRoot());
  const privateRoot = deps.privateRoot ?? (() => join(sandboxStateRoot(), 'setup'));
  const executor = deps.executor ?? createSandboxedCheckExecutor();

  return {
    async runStep(input) {
      const { step } = input;
      let worktree: string;
      try {
        worktree = realpathSync(input.workspace.worktreePath);
      } catch {
        return {
          result: toResult(step, {
            status: 'error', exitCode: null, signal: null, durationMs: 0, timedOut: false,
            log: { sha256: null, bytes: 0, truncated: false, tail: '', artifact: null },
            detail: 'the run\'s worktree does not exist',
          }),
          sandbox: null,
        };
      }
      const root = join(privateRoot(), input.runId);
      const artifacts = join(artifactsRoot(), input.runId);
      mkdirSync(root, { recursive: true, mode: 0o700 });
      mkdirSync(artifacts, { recursive: true, mode: 0o700 });
      const execution = await executor.run({
        check: step,
        checkoutPath: worktree,
        privateRoot: root,
        readRoots: [],
        // Other runs' worktrees and the mirrors stay out of reach; this worktree is the writable root.
        denyRoots: [reposRoot()],
        logPath: join(artifacts, `${String(input.index + 1).padStart(2, '0')}-${step.id}.log`),
        signal: input.signal,
      });
      return { result: toResult(step, execution), sandbox: execution.sandbox };
    },

    cleanup(runId) {
      try {
        rmSync(join(privateRoot(), runId), { recursive: true, force: true });
      } catch (error) {
        logger.warn({ err: error, runId }, '[Setup] private setup root not removed');
      }
    },

    fingerprint: worktreeFingerprint,

    async assertRunnable(worktreePath) {
      const decision = resolveSandboxMode(deps.env ?? process.env, Date.now());
      if (decision.mode === 'trusted-host') {
        let worktree = worktreePath;
        try {
          worktree = realpathSync(worktreePath);
        } catch {
          // The step reports a missing worktree itself.
        }
        if (!grantCovers(decision.grant, worktree)) throw new SandboxUnavailableError('No verified sandbox is available, and no trust grant covers this run\'s worktree; setup steps were not run', ['trust grant does not cover the worktree']);
        return;
      }
      await getVerifiedProvider();
    },
  };
}
