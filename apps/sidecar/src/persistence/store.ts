import type {
  ExecutionAttemptClient,
  ExecutionEvent,
  ExecutionLogEntry,
  ExecutionRunUsage,
} from '@openlinear/api-client';
import type { JournalRun } from '@openlinear/execution-core';
import type { PrincipalCredential } from '../auth/principal';
import type { TaskAuthority } from '../auth/task-access';
import { getCloudApiConfig } from '../config/cloud-api';
import { HttpError } from '../lib/errors';
import { shouldUsePrisma } from './boot';
import { loadPrismaStore } from './prisma-loader';

/**
 * Every persistence operation on the single-task execution path (W03a).
 *
 * Two implementations:
 * - `api`    — production. Authorizes and persists through the control plane
 *              with the request principal's own credential (start, reads) or
 *              the attempt's run-scoped capability (everything after start).
 *              No database credential, no signing secret.
 * - `prisma` — tests and `--with-cloud-api` against a loopback `*_test`
 *              database. Applies the same W01 fences directly; authorization
 *              still comes from the control plane (`auth/task-access`).
 */
export type PersistenceMode = 'api' | 'prisma';

export interface TaskSnapshot {
  id: string;
  title: string;
  description: string | null;
  model: string | null;
  agent: string | null;
  teamId: string | null;
  creatorId: string | null;
  workspaceId: string | null;
  projectId: string | null;
  project: {
    id: string;
    localPath: string | null;
    defaultAgent: string | null;
    repository: {
      id: string;
      name: string;
      fullName: string;
      cloneUrl: string;
      defaultBranch: string;
    } | null;
  } | null;
  labels: Array<{ taskId: string; labelId: string; label: { id: string; name: string; color: string } }>;
}

export interface ExecutionSettings {
  parallelLimit: number;
  maxBatchSize: number;
  queueAutoApprove: boolean;
  stopOnFailure: boolean;
  conflictBehavior: 'skip' | 'fail';
}

/** One execution attempt as seen by the sidecar. Memory only. */
export interface AttemptContext {
  taskId: string;
  userId: string;
  /** Control-plane attempt id (API mode); null in Prisma mode. */
  attemptId: string | null;
  /** API mode: client bound to the attempt's capability. Never logged. */
  client: ExecutionAttemptClient | null;
  /** Prisma mode: the request credential, kept for background re-authorization. */
  credential: PrincipalCredential | null;
  /** Set once the attempt was closed or released. */
  closed?: boolean;
}

/** Bindings a fenced write is conditional on (W01). */
export interface TaskFence {
  sessionId: string;
  /** `undefined` = legacy fixture without captured bindings (Prisma mode only). */
  projectId?: string | null;
  teamId: string | null;
  creatorId: string | null;
  /** Confirmed terminal projection of this execution, if any. */
  terminalStatus?: 'done' | 'cancelled';
}

export type TaskProjection = Record<string, unknown> & { id: string };

export interface ExecutionDataWrite {
  executionStartedAt?: Date;
  executionPausedAt?: Date | null;
  executionElapsedMs?: number;
  executionProgress?: number | null;
  prUrl?: string | null;
  outcome?: string | null;
}

export interface StartAttemptInput {
  taskId: string;
  userId: string;
  credential: PrincipalCredential | null;
  /** W17a: run although blockers are open (else 409 TASK_BLOCKED). */
  allowBlocked?: boolean;
  /** Local admission against the user's settings: an error message, or null to admit. */
  admit: (settings: ExecutionSettings) => string | null;
}

export type StartAttemptResult =
  | { ok: true; attempt: AttemptContext; task: TaskSnapshot; authority: TaskAuthority; settings: ExecutionSettings }
  | { ok: false; error: string; code?: string };

export interface ClaimInput {
  sessionId: string;
  runner: string;
  model: string;
  executionStartedAt: Date;
}

export interface TaskStatusWrite {
  taskId: string;
  status: 'in_progress' | 'done' | 'cancelled';
  sessionId: string | null;
  executionData?: ExecutionDataWrite;
  /** Null only for legacy unbound writes (Prisma mode). */
  fence: TaskFence | null;
}

export interface RunFinalization {
  agentRunId: string;
  status: 'succeeded' | 'failed' | 'cancelled';
  usage: ExecutionRunUsage & { reasoningTokens?: number };
  prUrl?: string | null;
  errorMessage?: string | null;
}

export interface RefreshPullRequestResult {
  prUrl: string | null;
  refreshed: boolean;
  message?: string;
}

export interface SidecarStore {
  readonly mode: PersistenceMode;
  /** Authorize execute, admit locally, snapshot the task, open the attempt. */
  startAttempt(input: StartAttemptInput): Promise<StartAttemptResult>;
  /** Git credential for clone/publish; memory only. Publish re-authorizes. */
  getGitCredential(attempt: AttemptContext, purpose: 'clone' | 'publish'): Promise<string | null>;
  /** Fenced in_progress claim + agent run creation. */
  claimAttempt(attempt: AttemptContext, input: ClaimInput): Promise<{ agentRunId: string | null; task: TaskProjection | null }>;
  /** Fenced terminal (or legacy) task status write. Throws when the fence rejects it. */
  writeTaskStatus(attempt: AttemptContext | null, input: TaskStatusWrite): Promise<TaskProjection | null>;
  /** Fenced log snapshot; a rejected fence is silently not written. */
  persistLogs(attempt: AttemptContext | null, input: { taskId: string; logs: ExecutionLogEntry[]; fence: TaskFence }): Promise<void>;
  finalizeRun(attempt: AttemptContext | null, input: RunFinalization & { taskId: string; userId: string | null }): Promise<void>;
  /** Re-authorize the initiator before publication; returns the publish credential. */
  authorizePublication(attempt: AttemptContext | null, input: { taskId: string; fence: TaskFence; currentToken: string | null }): Promise<string | null>;
  /** Positive provider stop receipt. */
  acknowledgeCancellation(attempt: AttemptContext): Promise<void>;
  /** Relay progress/log events (API mode); returns whether the control plane requested cancellation. */
  relayEvents(attempt: AttemptContext, events: ExecutionEvent[]): Promise<{ cancelRequested: boolean }>;
  heartbeat(attempt: AttemptContext): Promise<{ cancelRequested: boolean }>;
  /** Revoke the attempt's capability. Idempotent; never throws. */
  closeAttempt(attempt: AttemptContext, reason?: string): Promise<void>;
  readPersistedLogs(credential: PrincipalCredential | null, taskId: string): Promise<ExecutionLogEntry[]>;
  refreshPullRequest(credential: PrincipalCredential | null, taskId: string): Promise<RefreshPullRequestResult>;
  /** Journal recovery projection; API mode refuses (no capability survives a restart). */
  recordRecoveryOutcome(run: JournalRun, outcome: string): Promise<void>;
}

let override: SidecarStore | null = null;
let prismaStore: Promise<SidecarStore> | null = null;
let apiStore: Promise<SidecarStore> | null = null;

/** Tests: force a store implementation. */
export function setSidecarStore(store: SidecarStore | null): void {
  override = store;
}

export function resolvePersistenceMode(): PersistenceMode | 'unconfigured' {
  if (shouldUsePrisma()) return 'prisma';
  if (getCloudApiConfig()) return 'api';
  return 'unconfigured';
}

export async function getSidecarStore(): Promise<SidecarStore> {
  if (override) return override;
  const mode = resolvePersistenceMode();
  if (mode === 'prisma') {
    prismaStore ??= loadPrismaStore().catch((error: unknown) => {
      prismaStore = null;
      throw error;
    });
    return prismaStore;
  }
  if (mode === 'api') {
    apiStore ??= import('./api-store').then((module) => module.createApiStore());
    return apiStore;
  }
  throw new HttpError(503, 'CLOUD_API_NOT_CONFIGURED',
    'Execution is unavailable: the sidecar has no OPENLINEAR_API_URL (and no test database)');
}
