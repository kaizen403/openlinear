import { randomUUID } from 'node:crypto';
import { publishTaskEvent, publishUserEvent } from '../events/publisher';
import { HttpError } from '../lib/errors';
import { DurableRunJournal } from '../journal/durable';
import { logger } from '../lib/logger';
import { resolvePersistenceMode } from '../persistence/store';
import { ensureModelConfigured } from '../services/opencode-model';
import { ClaudeCodeRunner } from '../runners/claude-code/index';
import { CodexRunner } from '../runners/codex/index';
import { createApiControlPlane } from './control-plane';
import { registerRunService, resolveRunEngineMode, runEngineExplicit } from './engine-mode';
import { crashHookFromEnv } from './faults';
import { createOpenCodeRuntime } from './opencode-runtime';
import { createProcessRuntime } from './process-runtime';
import { createGitPublication } from './publication';
import type { RunRuntime } from './runtime';
import { RunBatchCoordinator } from './batch';
import { repositoryContextFor, repositoryContextSettings, type RepositoryContextInput } from '../context';
import { ReviewerService } from './reviewer';
import { RunService } from './service';
import { createLocalVerification } from './verification';
import { createLocalWorkspace } from './workspace';
import { appReposDir } from '../workspace/local-worktree';

/**
 * Production wiring of the v2 run service: SQLite journal in app data, the
 * W03a control plane through the attempt capability, OpenCode through the
 * AgentRunner contract and the W09a sandbox routing, git publication.
 */
let service: RunService | null = null;
let batches: RunBatchCoordinator | null = null;
let reviewer: ReviewerService | null = null;
let runtimes: ReadonlyMap<string, RunRuntime> | null = null;

/** v2 is selected (the default) and the sidecar persists through the control plane (W03a API mode). */
export function runEngineActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (resolveRunEngineMode(env) !== 'v2') return false;
  if (resolvePersistenceMode() !== 'api') {
    if (runEngineExplicit(env)) {
      logger.warn('[RunEngine] OPENLINEAR_RUN_ENGINE=v2 needs API persistence (OPENLINEAR_API_URL, no test database); using the legacy engine');
    }
    return false;
  }
  return true;
}

async function modelPreflight(userId: string): Promise<{ model: string | null; problem: string | null }> {
  try {
    const preflight = await ensureModelConfigured(userId);
    if (preflight.model) return { model: preflight.model, problem: null };
    return {
      model: null,
      problem: preflight.hasProvider
        ? 'A provider is connected but no model is selected. Choose a model in Settings → AI Providers.'
        : 'No AI provider is configured. Connect one in Settings → AI Providers before running tasks.',
    };
  } catch (error) {
    logger.warn({ err: error }, '[RunEngine] model preflight failed; continuing without it');
    return { model: null, problem: null };
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

export function getRunService(): RunService {
  if (service) return service;
  const journal = new DurableRunJournal(DurableRunJournal.defaultPath());
  const bootId = randomUUID();
  const owned = journal.claimOwnership({ pid: process.pid, bootId }, processAlive);
  if (!owned.ok) {
    journal.close();
    throw new HttpError(503, 'RUN_JOURNAL_LOCKED', `Another sidecar process (pid ${owned.pid}) owns the run journal`);
  }
  const controlPlane = createApiControlPlane();
  const engineRuntimes = new Map<string, RunRuntime>([
    ['opencode', createOpenCodeRuntime()],
    ['claude-code', createProcessRuntime(new ClaudeCodeRunner())],
    ['codex', createProcessRuntime(new CodexRunner())],
  ]);
  runtimes = engineRuntimes;
  service = new RunService({
    journal,
    bootId,
    controlPlane,
    // W07a: every native runner runs on the durable engine; selection
    // follows the task/project agent setting (resolveAgentId).
    runtimes: engineRuntimes,
    publication: createGitPublication(),
    workspace: createLocalWorkspace(),
    events: {
      publish: (taskId, ownerUserId, event, payload) => publishTaskEvent(taskId, event, payload, { ownerUserId }),
    },
    faults: crashHookFromEnv(),
    modelPreflight,
    // W11a: sealed checks before the prompt, pristine sandboxed verification after the commit.
    verification: createLocalVerification(),
    // W16b: relevant files at the base commit in the first prompt (OPENLINEAR_REPO_CONTEXT=0 turns it off).
    ...(repositoryContextSettings().enabled
      ? { repositoryContext: (input: RepositoryContextInput) => repositoryContextFor({ ...input, maxChars: repositoryContextSettings().maxChars }) }
      : {}),
  });
  registerRunService(service);
  // W13a: batches are coordinated sets of ordinary v2 runs.
  batches = new RunBatchCoordinator({
    service,
    journal,
    // W17a: members start after their in-batch blockers succeeded.
    dependencies: (credential, taskIds) => controlPlane.dependencyEdges?.(credential, taskIds) ?? Promise.resolve([]),
    events: { publish: (userId, event, payload) => publishUserEvent(userId, event, payload) },
  });
  logger.info({ journal: journal.path, bootId: service.bootId }, '[RunEngine] v2 run service started');
  return service;
}

/** W19a: the independent reviewer (fresh sessions of the same runners over a run's commit). */
export function getReviewer(): ReviewerService {
  const runs = getRunService();
  if (reviewer) return reviewer;
  if (!runtimes) throw new HttpError(503, 'RUN_ENGINE_STOPPED', 'The run engine is not running');
  reviewer = new ReviewerService({
    source: runs,
    runtimes,
    reposRoot: appReposDir,
    events: { publish: (taskId, ownerUserId, event, payload) => publishTaskEvent(taskId, event, payload, { ownerUserId }) },
  });
  // The 6-hourly retention sweep keeps a running review's checkout.
  const created = reviewer;
  runs.registerActiveCheckouts((entry) => created.isActiveCheckout(entry));
  return reviewer;
}

/** W13a: the batch coordinator of the v2 run service. */
export function getBatchCoordinator(): RunBatchCoordinator {
  getRunService();
  if (!batches) throw new HttpError(503, 'RUN_ENGINE_STOPPED', 'The run engine is not running');
  return batches;
}

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let retentionTimer: NodeJS.Timeout | null = null;

/**
 * W11a: `OPENLINEAR_WORKTREE_RETENTION_DAYS` (1–13, default 7). Bounded below
 * the journal's own 14-day record retention, so a worktree never outlives the
 * run record that explains it.
 */
export function retentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.OPENLINEAR_WORKTREE_RETENTION_DAYS?.trim();
  if (!raw) return null;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 13) {
    logger.warn({ value: raw }, '[RunEngine] OPENLINEAR_WORKTREE_RETENTION_DAYS must be an integer from 1 to 13; using 7');
    return null;
  }
  return days;
}

function sweepWorktrees(service: RunService): void {
  const days = retentionDaysFromEnv();
  void service.sweepRetention(days ? { retainMs: days * 24 * 60 * 60 * 1000 } : undefined).then((report) => {
    if (report && (report.removed.length > 0 || report.failed.length > 0)) {
      logger.info({ removed: report.removed.length, failed: report.failed.length, kept: report.kept }, '[RunEngine] worktree retention sweep');
    }
  });
}

/** Boot: recover journaled runs left by a previous process (non-blocking per run), then sweep retained worktrees. */
export async function startRunEngineRecovery(): Promise<{ recovered: number } | null> {
  if (!runEngineActive()) return null;
  const service = getRunService();
  const result = await service.recover();
  logger.info(result, '[RunEngine] journal recovery scheduled');
  await getBatchCoordinator().recover().catch((error: unknown) => logger.warn({ err: error }, '[RunEngine] batch recovery failed'));
  // Recovered runs are reserved by now, so their worktrees are kept.
  sweepWorktrees(service);
  if (!retentionTimer) {
    retentionTimer = setInterval(() => sweepWorktrees(service), RETENTION_SWEEP_INTERVAL_MS);
    retentionTimer.unref();
  }
  return result;
}
