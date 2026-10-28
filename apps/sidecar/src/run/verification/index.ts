import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPOSITORY_CHECKS_PATH,
  summarizeVerification,
  type VerificationCheckResult,
  type VerificationCheckSpec,
  type VerificationEnvironment,
  type VerificationManifest,
  type VerificationResult,
} from '@openlinear/execution-core';
import { defaultAppDataRoot } from '../../journal/durable';
import { logger } from '../../lib/logger';
import { sandboxStateRoot } from '../../sandbox/opencode-attempts';
import { appReposDir } from '../../workspace/local-worktree';
import type { RunSnapshot, RunWorkspace } from '../types';
import { createPristineCheckout, removePristineCheckout, verifyRoot } from './checkout';
import { createSandboxedCheckExecutor, type CheckExecution, type CheckExecutor, type CheckSandboxInfo } from './executor';
import { changedGradingInputs, resolveRunManifest } from './manifest';

/**
 * W11a verification port of the run service:
 *
 * - `resolveManifest` — before the prompt: seal the checks (precedence:
 *   project settings → base-commit `.openlinear/checks.json` → opt-in
 *   auto-detection; see execution-core `verification.ts`);
 * - `run` — after the candidate commit: pristine checkout of that exact
 *   commit, each sealed check executed in the sandbox with its timeout and
 *   network policy, bounded log artifacts, exit-code results, the checkout
 *   removed afterwards. Never throws for a check failure; the result says
 *   `failed`/`error`. A cancelled run returns what finished (`error`,
 *   remaining checks `skipped`) so the evidence is retained.
 */

export interface VerificationProgress {
  phase: 'start' | 'end';
  index: number;
  total: number;
  check: VerificationCheckSpec;
  result?: VerificationCheckResult;
}

export interface VerificationRunInput {
  runId: string;
  manifest: VerificationManifest;
  workspace: RunWorkspace;
  commitSha: string;
  runner: string;
  signal: AbortSignal;
  onProgress?: (progress: VerificationProgress) => void;
}

export interface VerificationPort {
  resolveManifest(input: { runId: string; snapshot: RunSnapshot; workspace: RunWorkspace }): Promise<VerificationManifest>;
  run(input: VerificationRunInput): Promise<VerificationResult>;
}

export interface LocalVerificationDeps {
  reposRoot?: () => string;
  artifactsRoot?: () => string;
  privateRoot?: () => string;
  executor?: CheckExecutor;
  now?: () => Date;
  platform?: string;
  arch?: string;
}

const MAX_COMMAND_DISPLAY = 400;

export function defaultArtifactsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(defaultAppDataRoot(env), 'artifacts', 'verification');
}

function displayCommand(argv: readonly string[]): string {
  const shell = argv.length === 3 && argv[0] === '/bin/sh' && argv[1] === '-c';
  const text = shell ? argv[2] ?? '' : argv.map((part) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
  return text.length > MAX_COMMAND_DISPLAY ? `${text.slice(0, MAX_COMMAND_DISPLAY)}…` : text;
}

function toResult(check: VerificationCheckSpec, execution: CheckExecution): VerificationCheckResult {
  return {
    id: check.id,
    name: check.name,
    required: check.required,
    status: execution.status,
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: Math.max(0, Math.round(execution.durationMs)),
    timedOut: execution.timedOut,
    network: check.network.mode,
    command: displayCommand(check.argv),
    log: execution.log,
    detail: execution.detail,
  };
}

function skipped(check: VerificationCheckSpec, detail: string): VerificationCheckResult {
  return {
    id: check.id,
    name: check.name,
    required: check.required,
    status: 'skipped',
    exitCode: null,
    signal: null,
    durationMs: 0,
    timedOut: false,
    network: check.network.mode,
    command: displayCommand(check.argv),
    log: { sha256: null, bytes: 0, truncated: false, tail: '', artifact: null },
    detail,
  };
}

function environmentOf(infos: readonly CheckSandboxInfo[], platform: string, arch: string): VerificationEnvironment {
  const ran = infos.filter((info) => info.mode !== 'none');
  const first = ran[0];
  return {
    sandboxMode: first?.mode ?? 'none',
    provider: first?.provider ?? null,
    providerVersion: first?.providerVersion ?? null,
    policyHashes: [...new Set(ran.map((info) => info.policyHash).filter((hash): hash is string => typeof hash === 'string'))],
    platform,
    arch,
    checkout: 'pristine-clone',
  };
}

export function createLocalVerification(deps: LocalVerificationDeps = {}): VerificationPort {
  const reposRoot = deps.reposRoot ?? appReposDir;
  const artifactsRoot = deps.artifactsRoot ?? (() => defaultArtifactsRoot());
  const privateRoot = deps.privateRoot ?? (() => join(sandboxStateRoot(), 'verify'));
  const executor = deps.executor ?? createSandboxedCheckExecutor();
  const now = deps.now ?? (() => new Date());
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  return {
    resolveManifest: ({ snapshot, workspace }) => resolveRunManifest({ snapshot, workspace, now }),

    async run(input) {
      const { manifest, commitSha } = input;
      const startedAt = now().toISOString();
      const base = {
        schemaVersion: 1 as const,
        commitSha,
        baseCommit: manifest.baseCommit,
        checksHash: manifest.checksHash,
        policy: manifest.policy,
        source: manifest.source,
        runner: input.runner,
        startedAt,
      };
      const warnings = [...manifest.warnings];
      const finish = (status: VerificationResult['status'], checks: VerificationCheckResult[], infos: CheckSandboxInfo[], detail: string | null): VerificationResult => ({
        ...base,
        status,
        checks,
        environment: environmentOf(infos, platform, arch),
        detail,
        warnings,
        finishedAt: now().toISOString(),
      });
      if (manifest.policy === 'off') return finish('skipped', [], [], 'verification is off for this project');
      if (manifest.checks.length === 0) {
        return manifest.problems.length > 0
          ? finish('error', [], [], manifest.problems.join('; '))
          : finish('skipped', [], [], 'no verification checks are configured');
      }
      const changed = await changedGradingInputs(input.workspace.worktreePath, manifest.baseCommit, commitSha);
      if (changed.includes(REPOSITORY_CHECKS_PATH)) {
        warnings.push(`the agent's commit changes ${REPOSITORY_CHECKS_PATH}; the copy from the base commit ${manifest.baseCommit?.slice(0, 12) ?? ''} was graded`);
      } else if (changed.length > 0) {
        warnings.push(`the agent's commit changes ${changed.join(', ')}`);
      }

      const root = reposRoot();
      let checkout: Awaited<ReturnType<typeof createPristineCheckout>>;
      try {
        checkout = await createPristineCheckout({ reposRoot: root, runId: input.runId, source: input.workspace.worktreePath, commit: commitSha });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ err: error, runId: input.runId }, '[Verify] pristine checkout failed');
        return finish('error', manifest.checks.map((check) => skipped(check, 'no pristine checkout')), [], `a pristine checkout of ${commitSha.slice(0, 12)} could not be created: ${message.slice(0, 300)}`);
      }
      const artifacts = join(artifactsRoot(), input.runId, commitSha.slice(0, 12));
      const privates = join(privateRoot(), input.runId);
      mkdirSync(artifacts, { recursive: true, mode: 0o700 });
      const results: VerificationCheckResult[] = [];
      const infos: CheckSandboxInfo[] = [];
      try {
        for (const [index, check] of manifest.checks.entries()) {
          if (input.signal.aborted) {
            results.push(skipped(check, 'verification was cancelled'));
            continue;
          }
          input.onProgress?.({ phase: 'start', index, total: manifest.checks.length, check });
          const checkRoot = join(privates, check.id);
          mkdirSync(checkRoot, { recursive: true, mode: 0o700 });
          const execution = await executor.run({
            check,
            checkoutPath: checkout.path,
            privateRoot: checkRoot,
            readRoots: checkout.alternateObjects,
            denyRoots: [root],
            logPath: join(artifacts, `${String(index + 1).padStart(2, '0')}-${check.id}.log`),
            signal: input.signal,
          });
          infos.push(execution.sandbox);
          const result = toResult(check, execution);
          results.push(result);
          input.onProgress?.({ phase: 'end', index, total: manifest.checks.length, check, result });
        }
      } finally {
        try {
          removePristineCheckout(root, checkout.path.startsWith(verifyRoot(root)) ? checkout.path : join(verifyRoot(root), input.runId));
        } catch (error) {
          logger.warn({ err: error, runId: input.runId }, '[Verify] pristine checkout not removed; the retention sweep collects it');
        }
        rmSync(privates, { recursive: true, force: true });
      }
      if (input.signal.aborted) return finish('error', results, infos, 'verification was cancelled before every check finished');
      const status = summarizeVerification(results);
      return finish(status, results, infos, status === 'error' ? results.find((check) => check.required && check.detail)?.detail ?? null : null);
    },
  };
}
