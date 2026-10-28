/**
 * W03a execution control plane.
 *
 * The local sidecar holds no database credential and no cloud signing secret.
 * It starts an attempt with the user's own credential, receives an immutable
 * snapshot plus a run-scoped capability, and performs every persistence step
 * through the capability-authenticated callbacks below. Each callback applies
 * the same conditional semantics the sidecar used to apply with Prisma (W01
 * fences), keyed by the values recorded on the attempt rather than anything
 * the caller sends.
 *
 * Attempt lifecycle:
 *   preparing --claim--> running --terminal--> finishing --close--> closed
 *   preparing --close / rejected claim / revoked access--> released
 *   running --close (no terminal result)--> closed ("abandoned"; task untouched)
 *
 * W05a additions: capabilities can be rotated while the lease is fresh
 * (`renewExecutionCapability`), and attempts whose sidecar stopped
 * heartbeating are fenced by the lease sweeper (services/execution-sweeper.ts).
 */
import { randomBytes } from 'node:crypto';
import { prisma, Prisma, type ExecutionAttempt } from '@openlinear/db';
import { hasRequiredScopes } from '@openlinear/api-core';
import type { ProjectVerificationSettings } from '@openlinear/execution-core';
import { HttpError } from '../errors';
import { logger } from '../logger';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { broadcastToTask, resolveTaskEventResource } from '../sse';
import { persistAndDeliver } from '../events/outbox';
import type { DomainEventAudience, DomainEventResource } from '../events/types';
import { promptKnowledge, type PromptKnowledge } from './knowledge';
import { resolveTenancyContext, runWithPrincipal } from '../tenancy/context';
import { scopedTaskWhere } from '../tenancy/scopes';
import type { TenancyContext } from '../tenancy/types';
import { assertNotBlocked, notifyUnblockedDependents } from './task-dependencies';
import { assertTaskAccess, isOwnershipError, type OwnedTask } from './ownership';
import { logActivity } from './activity';
import { decryptUserAccessToken } from './github';
import type { GitCredentialEffect } from './github-app';
import { assertVerifiedForDone, verificationSnapshotFor } from './execution-verification';
import { brokerAttemptGitCredential, revokeAttemptGitCredentials } from './github-app-credentials';
import {
  EXECUTION_CAPABILITY_PREFIX,
  EXECUTION_CAPABILITY_SCOPES,
  hashExecutionCapability,
  type ExecutionCapabilityContext,
} from '../middleware/execution-capability';
import type {
  AttemptCloseBody,
  AttemptEventsBody,
  AttemptGitCredentialBody,
  AttemptLogsBody,
  AttemptRunBody,
  AttemptTerminalBody,
  ClaimAttemptBody,
} from '../schemas/executions';

/**
 * Hard bound on a capability's lifetime. The legacy engine force-cancels a run
 * after 30 minutes and publication takes minutes, so two hours covers every
 * enabled path. Renewal for long-running attempts belongs to W05.
 */
export const EXECUTION_CAPABILITY_TTL_MS = 2 * 60 * 60 * 1000;

const CAPABILITY_RANDOM_BYTES = 32;
const CAPABILITY_DISPLAY_CHARS = 12;
type AttemptStatus = ExecutionAttempt['status'];
const ACTIVE_STATUSES: readonly AttemptStatus[] = ['preparing', 'running', 'finishing'];

function isActive(status: AttemptStatus): boolean {
  return status === 'preparing' || status === 'running' || status === 'finishing';
}

const SETTINGS_DEFAULTS = {
  parallelLimit: 3,
  maxBatchSize: 3,
  queueAutoApprove: false,
  stopOnFailure: false,
  conflictBehavior: 'skip' as 'skip' | 'fail',
  /** W15a: per-run budgets sealed with the attempt (null = no limit). */
  maxRunCostUsd: null as number | null,
  maxRunTokens: null as number | null,
  /** FE-04: how agent permission requests are answered (sealed with the attempt). */
  approvalMode: 'auto' as 'auto' | 'ask',
};

export type ExecutionSettingsSnapshot = typeof SETTINGS_DEFAULTS;

const taskSnapshotSelect = {
  id: true,
  title: true,
  description: true,
  model: true,
  agent: true,
  teamId: true,
  creatorId: true,
  workspaceId: true,
  projectId: true,
  archived: true,
  status: true,
  sessionId: true,
  project: {
    select: {
      id: true,
      localPath: true,
      defaultAgent: true,
      workspaceId: true,
      repository: { select: { id: true, name: true, fullName: true, cloneUrl: true, defaultBranch: true } },
    },
  },
  labels: { select: { taskId: true, labelId: true, label: { select: { id: true, name: true, color: true } } } },
} satisfies Prisma.TaskSelect;

type TaskSnapshotRow = Prisma.TaskGetPayload<{ select: typeof taskSnapshotSelect }>;

export interface ExecutionAuthoritySnapshot {
  id: string;
  projectId: string | null;
  teamId: string | null;
  creatorId: string | null;
  archived: boolean;
  status: string;
}

export interface ExecutionSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  task: Omit<TaskSnapshotRow, 'archived' | 'status' | 'sessionId'>;
  authority: ExecutionAuthoritySnapshot;
  settings: ExecutionSettingsSnapshot;
  /**
   * W11a: the project's verification settings at start (null = none). The
   * sidecar seals its manifest from this; the `done` gate and the evidence
   * checks read it back from the attempt, never the live project.
   */
  verification: ProjectVerificationSettings | null;
  /**
   * W19b: the project's active, unexpired knowledge at start (bounded; see
   * services/knowledge.ts `promptKnowledge`). Sealed with the attempt: a run
   * keeps the revisions it started with, and the ids/versions say which.
   */
  knowledge: PromptKnowledge[];
}

export interface StartedAttempt {
  attempt: { id: string; taskId: string; status: AttemptStatus; createdAt: string };
  capability: { token: string; expiresAt: string; scopes: string[] };
  snapshot: ExecutionSnapshot;
}

/**
 * A task an execution holds: in progress with a provider session bound. The
 * board's "In Progress" column alone (a status the user sets before pressing
 * Execute) is not a running execution.
 */
export function isHeldByExecution(task: { status: string; sessionId: string | null }): boolean {
  return task.status === 'in_progress' && task.sessionId !== null;
}

/** The claim fence's form of `!isHeldByExecution`. */
const NOT_HELD_BY_EXECUTION: Prisma.TaskWhereInput = { NOT: { status: 'in_progress', sessionId: { not: null } } };

function conflict(code: string, message: string, details?: unknown): HttpError {
  return new HttpError(409, code, message, details);
}

function attemptStateConflict(attempt: { status: AttemptStatus }, allowed: readonly AttemptStatus[]): HttpError {
  return conflict('ATTEMPT_STATE_CONFLICT', `Attempt is ${attempt.status}; this callback requires ${allowed.join(' or ')}`, {
    status: attempt.status,
    allowed,
  });
}

function generateCapabilityToken(): string {
  return `${EXECUTION_CAPABILITY_PREFIX}${randomBytes(CAPABILITY_RANDOM_BYTES).toString('base64url')}`;
}

function toAuthority(task: OwnedTask): ExecutionAuthoritySnapshot {
  return {
    id: task.id,
    projectId: task.projectId,
    teamId: task.teamId,
    creatorId: task.creatorId,
    archived: task.archived,
    status: task.status,
  };
}

/** Mirrors the sidecar's legacy `getExecutionSettings` lookup order. */
export async function loadExecutionSettings(userId: string): Promise<ExecutionSettingsSnapshot> {
  const row = (await prisma.settings.findUnique({ where: { userId } }))
    ?? (await prisma.settings.findFirst({ where: { userId: null } }));
  if (!row) return { ...SETTINGS_DEFAULTS };
  return {
    parallelLimit: row.parallelLimit ?? SETTINGS_DEFAULTS.parallelLimit,
    maxBatchSize: row.maxBatchSize ?? SETTINGS_DEFAULTS.maxBatchSize,
    queueAutoApprove: row.queueAutoApprove ?? SETTINGS_DEFAULTS.queueAutoApprove,
    stopOnFailure: row.stopOnFailure ?? SETTINGS_DEFAULTS.stopOnFailure,
    conflictBehavior: row.conflictBehavior === 'fail' ? 'fail' : 'skip',
    maxRunCostUsd: row.maxRunCostUsd ?? null,
    maxRunTokens: row.maxRunTokens ?? null,
    approvalMode: row.approvalMode === 'ask' ? 'ask' : 'auto',
  };
}

/** Same rule the sidecar applies before it reports success (W01 publication). */
export function isGithubPullRequestUrl(value: unknown, fullName: string): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const prefix = `/${fullName}/pull/`;
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.startsWith(prefix)
      && /^[1-9][0-9]*\/?$/.test(url.pathname.slice(prefix.length));
  } catch {
    return false;
  }
}

async function loadFlatTask(taskId: string) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { labels: { include: { label: true } } },
  });
  if (!task) return null;
  return { ...task, labels: task.labels.map((relation) => relation.label) };
}

async function broadcastTaskUpdated(taskId: string) {
  const flat = await loadFlatTask(taskId);
  if (!flat) return null;
  try {
    broadcastToTask('task:updated', flat);
  } catch (err) {
    logger.warn({ err, taskId }, '[executions] task:updated broadcast failed after a committed write');
  }
  return flat;
}

export async function lockAttempt(tx: Prisma.TransactionClient, attemptId: string): Promise<ExecutionAttempt> {
  await tx.$queryRaw`SELECT id FROM execution_attempts WHERE id = ${attemptId} FOR UPDATE`;
  const attempt = await tx.executionAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Execution attempt not found');
  return attempt;
}

export async function revokeCapabilities(tx: Prisma.TransactionClient, attemptId: string, at: Date): Promise<void> {
  await tx.executionCapability.updateMany({ where: { attemptId, revokedAt: null }, data: { revokedAt: at } });
}

/** The task row conditions every bound write of a claimed attempt requires. */
export function boundTaskWhere(attempt: ExecutionAttempt): Prisma.TaskWhereInput {
  return {
    id: attempt.taskId,
    status: 'in_progress',
    sessionId: attempt.sessionId,
    projectId: attempt.projectId,
    teamId: attempt.teamId,
    creatorId: attempt.creatorId,
  };
}

function bindingMatches(task: OwnedTask, attempt: ExecutionAttempt): boolean {
  return task.projectId === attempt.projectId && task.teamId === attempt.teamId && task.creatorId === attempt.creatorId;
}

/**
 * W12a: is the interactive session that started an attempt still valid? A
 * session the refresh flow rotated (`revokedAt` + `rotatedAt`) stays valid
 * while its family has a live successor — the user is still signed in. A
 * session revoked any other way (sign-out, "revoke all sessions", refresh
 * reuse revoking the family) or expired stops the attempt.
 */
async function sessionStillValid(sessionId: string, userId: string, now: Date): Promise<boolean> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { userId: true, revokedAt: true, rotatedAt: true, expiresAt: true, familyId: true },
  });
  if (!session || session.userId !== userId) return false;
  const live = (expiresAt: Date | null) => expiresAt === null || expiresAt > now;
  if (!session.revokedAt) return live(session.expiresAt);
  if (!session.rotatedAt || !session.familyId) return false;
  const successor = await prisma.session.count({
    where: { userId, familyId: session.familyId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  });
  return successor > 0;
}

/**
 * Background work keeps its initiating identity but is re-authorized before
 * claims, credentials, renewal and publication: current membership/grants
 * (explicit deny included), the PAT's workspace binding, and the credential
 * that started it — a revoked or expired PAT, or (W12a) a signed-out or
 * revoked interactive session, stops the attempt. Attempts started without a
 * recorded session (pre-W12a rows, sessionless test tokens) are not
 * session-checked.
 */
async function reauthorizeInitiator(attempt: ExecutionAttempt): Promise<OwnedTask> {
  if (attempt.authSource !== 'pat' && attempt.credentialId) {
    if (!(await sessionStillValid(attempt.credentialId, attempt.userId, new Date()))) {
      throw new HttpError(403, 'EXECUTION_ACCESS_REVOKED', 'The session that started this execution was signed out or revoked');
    }
  }
  if (attempt.authSource === 'pat') {
    const pat = attempt.credentialId
      ? await prisma.personalAccessToken.findUnique({
          where: { id: attempt.credentialId },
          select: { userId: true, revokedAt: true, expiresAt: true },
        })
      : null;
    if (!pat || pat.userId !== attempt.userId || pat.revokedAt || (pat.expiresAt && pat.expiresAt <= new Date())) {
      throw new HttpError(403, 'EXECUTION_ACCESS_REVOKED', 'The credential that started this execution is no longer valid');
    }
  }
  const principal = await resolveTenancyContext(
    {
      userId: attempt.userId,
      authSource: attempt.authSource === 'pat' ? 'pat' : 'jwt',
      scopes: [],
      credentialId: attempt.authSource === 'pat' ? attempt.credentialId : null,
      workspaceRestriction: attempt.workspaceRestriction,
    },
    { bypassCache: true },
  );
  let authority: OwnedTask;
  try {
    authority = await runWithPrincipal(principal, () => assertTaskAccess(attempt.taskId, attempt.userId, 'full'));
  } catch (err) {
    if (isOwnershipError(err)) {
      throw new HttpError(403, 'EXECUTION_ACCESS_REVOKED', 'The initiating user can no longer execute this task');
    }
    throw err;
  }
  if (authority.archived || !bindingMatches(authority, attempt)) {
    throw conflict('TASK_SCOPE_CHANGED', 'Task access scope changed after this attempt started');
  }
  return authority;
}

// ---------------------------------------------------------------------------
// User-authenticated operations
// ---------------------------------------------------------------------------

/**
 * Authorize the principal's execute permission, validate admission, record an
 * immutable snapshot and mint the attempt's capability. The task row is not
 * mutated here; the claim (after the sidecar has a provider session) performs
 * the fenced in_progress transition.
 */
export async function startExecutionAttempt(input: {
  userId: string;
  taskId: string;
  principal: TenancyContext | undefined;
  /** W12a: the interactive session that started it (re-checked like a PAT while the run lasts). */
  sessionId?: string | null;
  /** W17a: run it although blockers are open (follow-ups, explicit "run anyway"). */
  allowBlocked?: boolean;
}): Promise<StartedAttempt> {
  const authority = await assertTaskAccess(input.taskId, input.userId, 'full');
  if (authority.archived) throw conflict('TASK_ARCHIVED', 'Archived tasks cannot execute');

  const task = await prisma.task.findUnique({ where: { id: input.taskId }, select: taskSnapshotSelect });
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found');
  if (isHeldByExecution(task)) throw conflict('TASK_ALREADY_RUNNING', 'Task is already executing');
  if (task.projectId !== authority.projectId || task.teamId !== authority.teamId || task.creatorId !== authority.creatorId
    || task.archived) {
    throw conflict('TASK_SELECTION_CHANGED', 'Task access scope changed while execution was checked');
  }
  await assertNotBlocked(input.taskId, input.allowBlocked === true);

  const settings = await loadExecutionSettings(input.userId);
  const verification = await verificationSnapshotFor(task.projectId);
  const knowledge = await promptKnowledge(task.projectId);
  const { archived: _archived, status: _status, sessionId: _sessionId, ...taskSnapshot } = task;
  const snapshot: ExecutionSnapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    task: taskSnapshot,
    authority: toAuthority(authority),
    settings,
    verification,
    knowledge,
  };

  const isPat = input.principal?.authSource === 'pat';
  const token = generateCapabilityToken();
  const expiresAt = new Date(Date.now() + EXECUTION_CAPABILITY_TTL_MS);
  const scopes = [...EXECUTION_CAPABILITY_SCOPES];
  const repository = task.project?.repository ?? null;

  const attempt = await prisma.$transaction(async (tx) => {
    const created = await tx.executionAttempt.create({
      data: {
        taskId: task.id,
        userId: input.userId,
        authSource: isPat ? 'pat' : 'session',
        // The credential that started the attempt: the PAT, or the interactive session (W12a).
        credentialId: isPat ? input.principal?.credentialId ?? null : input.sessionId ?? null,
        workspaceRestriction: isPat ? input.principal?.workspaceRestriction ?? null : null,
        projectId: task.projectId,
        teamId: task.teamId,
        creatorId: task.creatorId,
        workspaceId: task.workspaceId ?? task.project?.workspaceId ?? null,
        repositoryId: repository?.id ?? null,
        repositoryFullName: repository?.fullName ?? null,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
    await tx.executionCapability.create({
      data: {
        attemptId: created.id,
        taskId: task.id,
        userId: input.userId,
        tokenHash: hashExecutionCapability(token),
        tokenPrefix: token.slice(0, CAPABILITY_DISPLAY_CHARS),
        scopes,
        expiresAt,
      },
    });
    return created;
  }, PRISMA_TX_OPTIONS);

  return {
    attempt: { id: attempt.id, taskId: attempt.taskId, status: attempt.status, createdAt: attempt.createdAt.toISOString() },
    capability: { token, expiresAt: expiresAt.toISOString(), scopes },
    snapshot,
  };
}

export interface TaskAccessDescription {
  taskId: string;
  permission: 'full' | 'view';
  /** Full permission and, for PATs, a scope that allows execution writes. */
  canWrite: boolean;
  authority: ExecutionAuthoritySnapshot;
}

/** Access decision the sidecar uses for status, logs and cancellation. */
export async function describeTaskAccess(input: {
  userId: string;
  taskId: string;
  authSource: 'jwt' | 'pat' | undefined;
  patScopes: readonly string[] | undefined;
}): Promise<TaskAccessDescription> {
  const viewed = await assertTaskAccess(input.taskId, input.userId, 'view');
  let permission: 'full' | 'view' = 'view';
  try {
    await assertTaskAccess(input.taskId, input.userId, 'full');
    permission = 'full';
  } catch (err) {
    if (!isOwnershipError(err)) throw err;
  }
  const writeScope = input.authSource !== 'pat' || hasRequiredScopes(input.patScopes ?? [], ['tasks:write']);
  return { taskId: viewed.id, permission, canWrite: permission === 'full' && writeScope, authority: toAuthority(viewed) };
}

export async function readPersistedTaskLogs(userId: string, taskId: string): Promise<unknown[]> {
  await assertTaskAccess(taskId, userId, 'full');
  const row = await prisma.task.findUnique({ where: { id: taskId }, select: { executionLogs: true } });
  return Array.isArray(row?.executionLogs) ? row.executionLogs : [];
}

/**
 * Cloud-side cancellation request: recorded on the active attempt and
 * delivered to its sidecar through heartbeat/event responses. The sidecar
 * stops the provider, writes the fenced cancelled projection and acknowledges
 * with a positive stop receipt.
 */
export async function requestTaskCancellation(userId: string, taskId: string) {
  await assertTaskAccess(taskId, userId, 'full');
  const attempt = await prisma.executionAttempt.findFirst({
    where: { taskId, status: { in: ['preparing', 'running'] } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, cancelRequestedAt: true, status: true },
  });
  if (!attempt) throw new HttpError(404, 'NO_ACTIVE_ATTEMPT', 'This task has no active execution attempt');
  const requestedAt = attempt.cancelRequestedAt ?? new Date();
  if (!attempt.cancelRequestedAt) {
    await prisma.executionAttempt.updateMany({
      where: { id: attempt.id, cancelRequestedAt: null, status: { in: ['preparing', 'running'] } },
      data: { cancelRequestedAt: requestedAt },
    });
  }
  return { attemptId: attempt.id, status: attempt.status, cancelRequestedAt: requestedAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Capability-authenticated callbacks
// ---------------------------------------------------------------------------

async function loadAttemptFor(capability: ExecutionCapabilityContext): Promise<ExecutionAttempt> {
  const attempt = await prisma.executionAttempt.findUnique({ where: { id: capability.attemptId } });
  if (!attempt) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Execution attempt not found');
  return attempt;
}

/**
 * The fenced in_progress transition. Conditional on the task still matching
 * the attempt's bindings, not archived and not already in progress; binds the
 * provider session, clears the legacy batch link and creates the AgentRun, all
 * in one transaction. A rejected claim releases the attempt.
 */
export async function claimExecutionAttempt(capability: ExecutionCapabilityContext, body: ClaimAttemptBody) {
  const before = await loadAttemptFor(capability);
  if (before.status !== 'preparing') throw attemptStateConflict(before, ['preparing']);
  try {
    await reauthorizeInitiator(before);
  } catch (err) {
    await releaseAttempt(before.id, 'access_revoked_before_claim');
    throw err;
  }

  const startedAt = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, before.id);
    if (attempt.status !== 'preparing') return { kind: 'state' as const, attempt };
    const claimed = await tx.task.updateMany({
      where: {
        id: attempt.taskId,
        archived: false,
        // Not held by another execution (a task the user moved to In Progress is claimable).
        ...NOT_HELD_BY_EXECUTION,
        projectId: attempt.projectId,
        teamId: attempt.teamId,
        creatorId: attempt.creatorId,
      },
      data: {
        status: 'in_progress',
        sessionId: body.sessionId,
        executionStartedAt: startedAt,
        executionPausedAt: null,
        executionElapsedMs: 0,
        executionProgress: 0,
        batchId: null,
      },
    });
    if (claimed.count !== 1) {
      const current = await tx.task.findUnique({
        where: { id: attempt.taskId },
        select: { archived: true, status: true, sessionId: true },
      });
      await tx.executionAttempt.update({
        where: { id: attempt.id },
        data: { status: 'released', closedAt: startedAt, closeReason: 'claim_rejected' },
      });
      await revokeCapabilities(tx, attempt.id, startedAt);
      return { kind: 'rejected' as const, archived: current?.archived ?? false, held: current ? isHeldByExecution(current) : false };
    }
    const run = await tx.agentRun.create({
      data: {
        taskId: attempt.taskId,
        userId: attempt.userId,
        agent: body.runner,
        runner: body.runner,
        model: body.model,
        externalSessionId: body.sessionId,
        status: 'running',
      },
      select: { id: true },
    });
    const updated = await tx.executionAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'running',
        sessionId: body.sessionId,
        agentRunId: run.id,
        runner: body.runner,
        model: body.model,
        claimedAt: startedAt,
        heartbeatAt: startedAt,
      },
    });
    return { kind: 'claimed' as const, attempt: updated, agentRunId: run.id };
  }, PRISMA_TX_OPTIONS);

  if (outcome.kind === 'state') throw attemptStateConflict(outcome.attempt, ['preparing']);
  if (outcome.kind === 'rejected') {
    // W10a: the rejected claim released the attempt; revoke its fetch token.
    await revokeAttemptGitCredentials(before.id);
    if (outcome.archived) throw conflict('TASK_ARCHIVED', 'Archived tasks cannot execute');
    if (outcome.held) throw conflict('TASK_ALREADY_RUNNING', 'Task is already executing');
    throw conflict('TASK_SELECTION_CHANGED', 'Task access scope changed before the claim');
  }

  await logActivity({
    taskId: outcome.attempt.taskId,
    teamId: outcome.attempt.teamId,
    projectId: outcome.attempt.projectId,
    userId: outcome.attempt.userId,
    action: 'agent_run_started',
    payload: { agentRunId: outcome.agentRunId, agent: body.runner, model: body.model, attemptId: outcome.attempt.id },
  });
  const task = await broadcastTaskUpdated(outcome.attempt.taskId);
  return { attemptId: outcome.attempt.id, status: outcome.attempt.status, agentRunId: outcome.agentRunId, task };
}

async function releaseAttempt(attemptId: string, reason: string): Promise<void> {
  const at = new Date();
  await prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, attemptId);
    if (attempt.status !== 'preparing') return;
    await tx.executionAttempt.update({ where: { id: attemptId }, data: { status: 'released', closedAt: at, closeReason: reason } });
    await revokeCapabilities(tx, attemptId, at);
  }, PRISMA_TX_OPTIONS);
  // W10a: a fetch token issued while preparing dies with the released attempt.
  await revokeAttemptGitCredentials(attemptId);
}

export function taskEventAudience(attempt: ExecutionAttempt): DomainEventAudience {
  return {
    userIds: [...new Set([attempt.userId, attempt.creatorId].filter((id): id is string => Boolean(id)))],
    teamIds: attempt.teamId ? [attempt.teamId] : [],
    workspaceIds: attempt.workspaceId ? [attempt.workspaceId] : [],
  };
}

/**
 * Relay progress/log events. Idempotent by (attempt, sequence): sequences at
 * or below the attempt's high-water mark are acknowledged as duplicates and
 * not delivered again. Delivery uses the task's resource binding, so every
 * subscriber is authorized against current policy (W02a).
 */
export async function recordAttemptEvents(capability: ExecutionCapabilityContext, body: AttemptEventsBody) {
  const ordered = [...body.events].sort((a, b) => a.seq - b.seq)
    .filter((event, index, all) => index === 0 || all[index - 1].seq !== event.seq);
  const result = await prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, capability.attemptId);
    if (!isActive(attempt.status)) {
      return { kind: 'state' as const, attempt };
    }
    const fresh = ordered.filter((event) => event.seq > attempt.lastEventSeq);
    const lastEventSeq = fresh.length > 0 ? fresh[fresh.length - 1].seq : attempt.lastEventSeq;
    await tx.executionAttempt.update({
      where: { id: attempt.id },
      data: { lastEventSeq, heartbeatAt: new Date() },
    });
    return { kind: 'ok' as const, attempt, fresh, lastEventSeq };
  }, PRISMA_TX_OPTIONS);
  if (result.kind === 'state') throw attemptStateConflict(result.attempt, ACTIVE_STATUSES);

  if (result.fresh.length > 0) {
    const attempt = result.attempt;
    const resource: DomainEventResource = (await resolveTaskEventResource({
      projectId: attempt.projectId,
      teamId: attempt.teamId,
      creatorId: attempt.creatorId,
    })) ?? { type: 'user' };
    const audience = taskEventAudience(attempt);
    for (const event of result.fresh) {
      await persistAndDeliver({
        type: event.type,
        payload: { ...event.payload, taskId: attempt.taskId },
        actorId: attempt.userId,
        workspaceId: resource.workspaceId ?? attempt.workspaceId,
        audience,
        resource,
      });
    }
  }

  return {
    accepted: result.fresh.length,
    duplicates: ordered.length - result.fresh.length,
    lastSeq: result.lastEventSeq,
    cancelRequested: Boolean(result.attempt.cancelRequestedAt),
  };
}

export async function heartbeatExecutionAttempt(capability: ExecutionCapabilityContext) {
  const now = new Date();
  const updated = await prisma.executionAttempt.updateMany({
    where: { id: capability.attemptId, status: { in: [...ACTIVE_STATUSES] } },
    data: { heartbeatAt: now },
  });
  const attempt = await loadAttemptFor(capability);
  if (updated.count !== 1) throw attemptStateConflict(attempt, ACTIVE_STATUSES);
  return {
    attemptId: attempt.id,
    status: attempt.status,
    cancelRequested: Boolean(attempt.cancelRequestedAt),
    heartbeatAt: now.toISOString(),
    capabilityExpiresAt: capability.expiresAt.toISOString(),
  };
}

/**
 * Persist the captured log snapshot. Before a terminal projection the task
 * must still be in progress under this attempt's session; afterwards it must
 * carry this attempt's confirmed terminal status with the session cleared.
 * Bindings must match either way. A rejected fence is not an error: the logs
 * belong to a replacement owner and are simply not written (W01 semantics).
 */
export async function persistAttemptLogs(capability: ExecutionCapabilityContext, body: AttemptLogsBody) {
  const attempt = await loadAttemptFor(capability);
  if (attempt.status !== 'running' && attempt.status !== 'finishing') {
    throw attemptStateConflict(attempt, ['running', 'finishing']);
  }
  const where: Prisma.TaskWhereInput = attempt.status === 'finishing' && attempt.terminalStatus
    ? {
        id: attempt.taskId,
        status: attempt.terminalStatus,
        sessionId: null,
        projectId: attempt.projectId,
        teamId: attempt.teamId,
        creatorId: attempt.creatorId,
      }
    : boundTaskWhere(attempt);
  const written = await prisma.task.updateMany({
    where,
    data: { executionLogs: body.logs as unknown as Prisma.InputJsonValue },
  });
  return { persisted: written.count === 1 };
}

/**
 * Terminal task projection (legacy `done` / `cancelled`). Fenced exactly like
 * the sidecar's single-task terminal write: in progress, this attempt's
 * session, unchanged project/team/creator. Repeating the same terminal status
 * is an idempotent no-op that never rewrites the row; a different one
 * conflicts. `done` additionally requires a confirmed pull request on the
 * attempt's repository (a compare link or foreign PR is not success).
 */
export async function writeAttemptTerminal(capability: ExecutionCapabilityContext, body: AttemptTerminalBody) {
  if (body.status === 'done') {
    const attempt = await loadAttemptFor(capability);
    if (!attempt.repositoryFullName || !isGithubPullRequestUrl(body.prUrl, attempt.repositoryFullName)) {
      throw new HttpError(422, 'PUBLICATION_UNVERIFIED', 'A done projection requires a confirmed pull request on the attempt repository');
    }
    // W11a: a sealed require-pass policy needs passing evidence for this attempt.
    await assertVerifiedForDone(attempt);
  }
  const finishedAt = new Date();
  const outcome = await prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, capability.attemptId);
    if (attempt.status === 'finishing') {
      if (attempt.terminalStatus === body.status) return { kind: 'repeat' as const, attempt };
      return { kind: 'terminal-conflict' as const, attempt };
    }
    if (attempt.status !== 'running') return { kind: 'state' as const, attempt };
    const written = await tx.task.updateMany({
      where: boundTaskWhere(attempt),
      data: {
        status: body.status,
        sessionId: null,
        ...(body.executionElapsedMs !== undefined ? { executionElapsedMs: body.executionElapsedMs } : {}),
        ...(body.executionProgress !== undefined ? { executionProgress: body.executionProgress } : {}),
        ...(body.executionPausedAt !== undefined
          ? { executionPausedAt: body.executionPausedAt ? new Date(body.executionPausedAt) : null }
          : {}),
        ...(body.prUrl !== undefined ? { prUrl: body.prUrl } : {}),
        ...(body.outcome !== undefined ? { outcome: body.outcome } : {}),
      },
    });
    if (written.count !== 1) return { kind: 'fenced' as const, attempt };
    const updated = await tx.executionAttempt.update({
      where: { id: attempt.id },
      data: { status: 'finishing', terminalStatus: body.status, finishedAt },
    });
    return { kind: 'written' as const, attempt: updated };
  }, PRISMA_TX_OPTIONS);

  if (outcome.kind === 'state') throw attemptStateConflict(outcome.attempt, ['running']);
  if (outcome.kind === 'terminal-conflict') {
    throw conflict('ATTEMPT_TERMINAL_CONFLICT', `Attempt already recorded ${outcome.attempt.terminalStatus}`, {
      terminalStatus: outcome.attempt.terminalStatus,
    });
  }
  if (outcome.kind === 'fenced') {
    throw conflict('TASK_FENCE_REJECTED', 'The task is no longer owned by this attempt; nothing was written');
  }
  const task = outcome.kind === 'written'
    ? await broadcastTaskUpdated(outcome.attempt.taskId)
    : await loadFlatTask(outcome.attempt.taskId);
  // W17a: an agent finishing a blocker unblocks its dependents (no person acted).
  if (outcome.kind === 'written' && body.status === 'done') await notifyUnblockedDependents({ taskIds: [outcome.attempt.taskId], actorUserId: null });
  return {
    attemptId: outcome.attempt.id,
    status: outcome.attempt.status,
    terminalStatus: outcome.attempt.terminalStatus,
    repeated: outcome.kind === 'repeat',
    task,
  };
}

/**
 * AgentRun finalization. `succeeded` requires this attempt's confirmed `done`
 * projection; `cancelled` requires a positive provider stop receipt. A run
 * that is no longer `running` is never rewritten.
 */
export async function finalizeAttemptRun(capability: ExecutionCapabilityContext, body: AttemptRunBody) {
  const attempt = await loadAttemptFor(capability);
  if (attempt.status !== 'running' && attempt.status !== 'finishing') {
    throw attemptStateConflict(attempt, ['running', 'finishing']);
  }
  if (!attempt.agentRunId) throw conflict('ATTEMPT_NOT_CLAIMED', 'This attempt has no agent run');
  if (body.status === 'succeeded' && attempt.terminalStatus !== 'done') {
    throw conflict('RUN_SUCCESS_UNCONFIRMED', 'A run can succeed only after its done projection was confirmed');
  }
  if (body.status === 'cancelled' && !attempt.cancelAcknowledgedAt) {
    throw conflict('CANCEL_NOT_ACKNOWLEDGED', 'A cancelled run requires a positive provider stop receipt first');
  }
  const usage = body.usage ?? {};
  const data: Prisma.AgentRunUpdateManyMutationInput = {
    endedAt: new Date(),
    status: body.status,
    ...(usage.costUsd !== undefined && usage.costUsd > 0 ? { costUsd: new Prisma.Decimal(usage.costUsd.toFixed(6)) } : {}),
    ...(usage.inputTokens !== undefined && usage.inputTokens > 0 ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined && usage.outputTokens > 0 ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    ...(usage.costBasis !== undefined ? { costBasis: usage.costBasis } : {}),
    ...(body.prUrl ? { prUrl: body.prUrl } : {}),
    ...(body.errorMessage ? { errorMessage: body.errorMessage.slice(0, 1_000) } : {}),
  };
  const updated = await prisma.agentRun.updateMany({ where: { id: attempt.agentRunId, status: 'running' }, data });
  if (updated.count === 1) {
    await logActivity({
      taskId: attempt.taskId,
      teamId: attempt.teamId,
      projectId: attempt.projectId,
      userId: attempt.userId,
      action: 'agent_run_completed',
      payload: {
        agentRunId: attempt.agentRunId,
        attemptId: attempt.id,
        status: body.status,
        ...(body.prUrl ? { prUrl: body.prUrl } : {}),
        ...(body.errorMessage ? { errorMessage: body.errorMessage.slice(0, 500) } : {}),
        ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.cachedInputTokens ? { cacheReadTokens: usage.cachedInputTokens } : {}),
        ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      },
    });
  }
  return { agentRunId: attempt.agentRunId, finalized: updated.count === 1 };
}

/** Positive stop receipt for a cancellation (requested locally or via the API). */
export async function acknowledgeAttemptCancellation(capability: ExecutionCapabilityContext) {
  const now = new Date();
  const updated = await prisma.executionAttempt.updateMany({
    where: { id: capability.attemptId, status: { in: ['running', 'finishing'] } },
    data: { cancelAcknowledgedAt: now },
  });
  const attempt = await loadAttemptFor(capability);
  if (updated.count !== 1) throw attemptStateConflict(attempt, ['running', 'finishing']);
  return {
    attemptId: attempt.id,
    cancelRequestedAt: attempt.cancelRequestedAt?.toISOString() ?? null,
    cancelAcknowledgedAt: now.toISOString(),
  };
}

/**
 * W10a: attempt-scoped git credential for ONE effect (`fetch` | `push` |
 * `pull_request`), kept in sidecar memory only. The broker
 * (services/github-app-credentials.ts) issues a GitHub App installation token
 * restricted to the attempt's repository and the effect's permissions, or —
 * only if the fallback policy allows it — the initiating user's OAuth token
 * (never to workspace-bound PAT attempts). The response says which kind was
 * issued. Every issue re-authorizes the initiator; `push`/`pull_request`
 * additionally require the task to still be bound to this attempt. The
 * legacy `{ purpose }` body maps `clone` → fetch and `publish` → pull_request.
 */
export async function issueAttemptGitCredential(capability: ExecutionCapabilityContext, body: AttemptGitCredentialBody) {
  const legacyPurpose = 'purpose' in body ? body.purpose : null;
  const effect: GitCredentialEffect = 'effect' in body ? body.effect : body.purpose === 'publish' ? 'pull_request' : 'fetch';
  const attempt = await loadAttemptFor(capability);
  const allowed: readonly AttemptStatus[] = effect === 'fetch' ? ['preparing', 'running'] : ['running'];
  if (!allowed.includes(attempt.status)) throw attemptStateConflict(attempt, allowed);
  await reauthorizeInitiator(attempt);
  if (effect !== 'fetch') {
    const bound = await prisma.task.count({ where: { ...boundTaskWhere(attempt), archived: false } });
    if (bound !== 1) throw conflict('TASK_FENCE_REJECTED', 'The task is no longer owned by this attempt; publication refused');
  }
  const issued = await brokerAttemptGitCredential({ attempt, effect, capabilityExpiresAt: capability.expiresAt });
  return {
    ...issued,
    // Echoed for pre-W10a sidecars, which read `token` only.
    ...(legacyPurpose ? { purpose: legacyPurpose } : {}),
  };
}

/**
 * End of the attempt's local lifecycle: revoke every capability. A preparing
 * attempt becomes `released`; a claimed one `closed` (`abandoned` when no
 * terminal projection was confirmed — the task row is left untouched, since
 * its ownership could not be proven). Idempotent.
 */
export async function closeExecutionAttempt(capability: ExecutionCapabilityContext, body: AttemptCloseBody) {
  const at = new Date();
  const attempt = await prisma.$transaction(async (tx) => {
    const current = await lockAttempt(tx, capability.attemptId);
    if (current.status === 'closed' || current.status === 'released') {
      await revokeCapabilities(tx, current.id, at);
      return current;
    }
    const status = current.status === 'preparing' ? 'released' : 'closed';
    const closeReason = body.reason
      ?? (current.status === 'running' ? 'abandoned' : current.status === 'preparing' ? 'released' : 'completed');
    const updated = await tx.executionAttempt.update({
      where: { id: current.id },
      data: { status, closedAt: at, closeReason },
    });
    await revokeCapabilities(tx, current.id, at);
    return updated;
  }, PRISMA_TX_OPTIONS);
  // W10a: installation tokens die with the attempt (never throws).
  await revokeAttemptGitCredentials(attempt.id);
  return {
    attemptId: attempt.id,
    status: attempt.status,
    terminalStatus: attempt.terminalStatus,
    closeReason: attempt.closeReason,
  };
}

// ---------------------------------------------------------------------------
// Capability renewal (W05a): long runs outlive the 2 h capability TTL
// ---------------------------------------------------------------------------

/** A heartbeat older than this means the sidecar is gone (lease sweeper, renewal). */
export const DEFAULT_ATTEMPT_LEASE_MS = 5 * 60 * 1000;
/** Hard bound on an attempt's total lifetime across renewals. */
export const DEFAULT_ATTEMPT_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** A rotated capability stays usable this long, so a lost renewal response can be retried. */
export const CAPABILITY_RENEWAL_GRACE_MS = 5 * 60 * 1000;

function boundedEnvMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

/** `OPENLINEAR_ATTEMPT_LEASE_MS`, bounded to [30 s, 24 h]. */
export function attemptLeaseMs(env: NodeJS.ProcessEnv = process.env): number {
  return boundedEnvMs(env.OPENLINEAR_ATTEMPT_LEASE_MS, DEFAULT_ATTEMPT_LEASE_MS, 30_000, 24 * 60 * 60 * 1000);
}

/** `OPENLINEAR_ATTEMPT_MAX_LIFETIME_MS`, bounded to [1 h, 7 d]. */
export function attemptMaxLifetimeMs(env: NodeJS.ProcessEnv = process.env): number {
  return boundedEnvMs(env.OPENLINEAR_ATTEMPT_MAX_LIFETIME_MS, DEFAULT_ATTEMPT_MAX_LIFETIME_MS, 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
}

/**
 * Rotate the attempt's capability. Requires an active attempt whose lease is
 * fresh (a swept or lapsed attempt cannot extend itself) and re-authorizes the
 * initiator. The presented capability keeps working for a short grace window
 * so a lost response can be retried; every capability still dies at close.
 */
export async function renewExecutionCapability(capability: ExecutionCapabilityContext) {
  const before = await loadAttemptFor(capability);
  if (!isActive(before.status)) throw attemptStateConflict(before, ACTIVE_STATUSES);
  const now = new Date();
  const lifetimeEnd = before.createdAt.getTime() + attemptMaxLifetimeMs();
  if (lifetimeEnd <= now.getTime()) {
    throw conflict('ATTEMPT_LIFETIME_EXCEEDED', 'This attempt reached its maximum lifetime; start a new execution');
  }
  await reauthorizeInitiator(before);

  const token = generateCapabilityToken();
  const expiresAt = new Date(Math.min(now.getTime() + EXECUTION_CAPABILITY_TTL_MS, lifetimeEnd));
  const scopes = [...EXECUTION_CAPABILITY_SCOPES];
  const outcome = await prisma.$transaction(async (tx) => {
    const attempt = await lockAttempt(tx, before.id);
    if (!isActive(attempt.status)) return { kind: 'state' as const, attempt };
    if (attempt.heartbeatAt.getTime() < now.getTime() - attemptLeaseMs()) return { kind: 'lease' as const, attempt };
    const presented = await tx.executionCapability.findUnique({ where: { id: capability.capabilityId }, select: { expiresAt: true } });
    const previousExpiresAt = new Date(Math.min(presented?.expiresAt.getTime() ?? now.getTime(), now.getTime() + CAPABILITY_RENEWAL_GRACE_MS));
    await tx.executionCapability.updateMany({
      where: { id: capability.capabilityId, revokedAt: null },
      data: { expiresAt: previousExpiresAt },
    });
    await tx.executionCapability.create({
      data: {
        attemptId: attempt.id,
        taskId: attempt.taskId,
        userId: attempt.userId,
        tokenHash: hashExecutionCapability(token),
        tokenPrefix: token.slice(0, CAPABILITY_DISPLAY_CHARS),
        scopes,
        expiresAt,
      },
    });
    const updated = await tx.executionAttempt.update({
      where: { id: attempt.id },
      data: { heartbeatAt: now, renewedAt: now, renewals: { increment: 1 } },
    });
    return { kind: 'renewed' as const, attempt: updated, previousExpiresAt };
  }, PRISMA_TX_OPTIONS);

  if (outcome.kind === 'state') throw attemptStateConflict(outcome.attempt, ACTIVE_STATUSES);
  if (outcome.kind === 'lease') {
    throw conflict('ATTEMPT_LEASE_EXPIRED', 'The attempt lease lapsed; it can no longer be renewed');
  }
  return {
    attemptId: outcome.attempt.id,
    capability: { token, expiresAt: expiresAt.toISOString(), scopes },
    previousExpiresAt: outcome.previousExpiresAt.toISOString(),
    renewals: outcome.attempt.renewals,
  };
}

// ---------------------------------------------------------------------------
// Pull request refresh (moved server-side from the sidecar's Prisma route)
// ---------------------------------------------------------------------------

const COMPARE_URL_PATTERN = /github\.com\/([^/]+)\/([^/]+)\/compare\/.+\.\.\.(.+)$/;

export async function refreshTaskPullRequest(input: {
  userId: string;
  taskId: string;
  principal: TenancyContext | undefined;
  workspaceBoundPat: boolean;
}) {
  await assertTaskAccess(input.taskId, input.userId, 'full');
  const task = await prisma.task.findUnique({ where: { id: input.taskId }, select: { prUrl: true, batchId: true } });
  if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found');
  if (!task.prUrl?.includes('/compare/')) return { prUrl: task.prUrl, refreshed: false };
  const match = task.prUrl.match(COMPARE_URL_PATTERN);
  if (!match) return { prUrl: task.prUrl, refreshed: false };
  const [, owner, repo, rawBranch] = match;
  let branch: string;
  try {
    branch = decodeURIComponent(rawBranch);
  } catch {
    return { prUrl: task.prUrl, refreshed: false };
  }

  if (input.workspaceBoundPat) {
    throw new HttpError(403, 'PAT_WORKSPACE_RESTRICTED',
      'Account-wide credentials are not available to a workspace-bound personal access token');
  }
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { accessToken: true } });
  const accessToken = decryptUserAccessToken(user?.accessToken ?? null);
  if (!accessToken) {
    throw new HttpError(400, 'GITHUB_NOT_LINKED', 'GitHub authentication required to refresh PR status');
  }

  const query = new URLSearchParams({ head: `${owner}:${branch}`, state: 'all', per_page: '1' });
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) throw new HttpError(502, 'GITHUB_REQUEST_FAILED', 'GitHub API request failed');
  const pulls: unknown = await response.json();
  const first = Array.isArray(pulls) ? pulls[0] : undefined;
  const newPrUrl = first && typeof first === 'object' && typeof (first as { html_url?: unknown }).html_url === 'string'
    ? (first as { html_url: string }).html_url
    : null;
  if (!newPrUrl || !isGithubPullRequestUrl(newPrUrl, `${owner}/${repo}`)) {
    return { prUrl: task.prUrl, refreshed: false, message: 'No PR found for this branch yet' };
  }

  const oldPrUrl = task.prUrl;
  await prisma.task.update({ where: { id: input.taskId }, data: { prUrl: newPrUrl } });
  if (task.batchId && input.principal) {
    // Batch siblings share the pull request, but only rows the caller may
    // fully access are rewritten.
    await prisma.task.updateMany({
      where: { AND: [{ batchId: task.batchId, prUrl: oldPrUrl }, scopedTaskWhere(input.principal, {}, 'full')] },
      data: { prUrl: newPrUrl },
    });
  }
  await broadcastTaskUpdated(input.taskId);
  return { prUrl: newPrUrl, refreshed: true };
}
