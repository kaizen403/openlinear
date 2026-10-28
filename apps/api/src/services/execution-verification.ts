import { createHash } from 'node:crypto';
import {
  checksHashOf,
  DEFAULT_VERIFICATION_POLICY,
  parseProjectVerificationSettings,
  verificationPublicationDecision,
  type ProjectVerificationSettings,
  type VerificationPolicy,
} from '@openlinear/execution-core';
import { prisma, Prisma, type ExecutionAttempt } from '@openlinear/db';
import { HttpError, ValidationError } from '../errors';
import { logger } from '../logger';
import type { ExecutionCapabilityContext } from '../middleware/execution-capability';
import type { AttemptVerificationBody } from '../schemas/executions';
import { logAudit } from './audit';
import { canonicalJson } from './idempotency';
import { assertProjectAccess, assertTaskAccess } from './ownership';
import { assertWorkspaceRole } from './workspaces';

/**
 * W11a "done means verified" on the control plane.
 *
 * - Project verification settings (`linear_projects.executionSettings
 *   .verification`): what checks run and whether they gate publication.
 *   Edited by workspace owners/admins only — the checks are commands every
 *   member's sidecar runs (sandboxed) when executing the project's tasks.
 * - The attempt snapshot seals the settings at start; the sidecar resolves
 *   the manifest from them (or the base commit's `.openlinear/checks.json`).
 * - Evidence (`execution_verifications`): one row per (attempt, commit,
 *   checks hash), idempotent by body hash. The policy it claims must be the
 *   sealed one, project-defined checks must hash to the sealed checks, and
 *   `publication` must be what the policy decides for the status.
 * - Gate: under a sealed `require-pass` policy a `done` projection needs a
 *   passing record for the attempt — an old or misbehaving sidecar cannot
 *   mark a task done without verified evidence.
 * - W16a: the same settings carry the project's environment setup steps
 *   (`setup`), run by the sidecar in the worktree before the agent starts.
 *   Same parser, same owner/admin rule, sealed in the same snapshot value
 *   (`snapshot.verification.setup`), so a run uses the steps it started with.
 */

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The validated settings stored on a project, or null when none (or unreadable). */
export function storedVerificationSettings(raw: Prisma.JsonValue | null | undefined): ProjectVerificationSettings | null {
  if (!isRecord(raw) || raw.verification === undefined || raw.verification === null) return null;
  const parsed = parseProjectVerificationSettings(raw.verification);
  return parsed.ok ? parsed.value : null;
}

/** What the attempt snapshot seals (null = the project configures no verification). */
export async function verificationSnapshotFor(projectId: string | null): Promise<ProjectVerificationSettings | null> {
  if (!projectId) return null;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { executionSettings: true } });
  return storedVerificationSettings(project?.executionSettings);
}

/** The settings an attempt was started with (from its immutable snapshot). */
export function sealedVerificationSettings(attempt: Pick<ExecutionAttempt, 'snapshot'>): ProjectVerificationSettings | null {
  const snapshot = attempt.snapshot;
  if (!isRecord(snapshot) || snapshot.verification === undefined || snapshot.verification === null) return null;
  const parsed = parseProjectVerificationSettings(snapshot.verification);
  return parsed.ok ? parsed.value : null;
}

export function sealedVerificationPolicy(attempt: Pick<ExecutionAttempt, 'snapshot'>): VerificationPolicy {
  return sealedVerificationSettings(attempt)?.policy ?? DEFAULT_VERIFICATION_POLICY;
}

export interface RecordedVerification {
  id: string;
  attemptId: string;
  repeated: boolean;
}

export async function recordAttemptVerification(capability: ExecutionCapabilityContext, body: AttemptVerificationBody): Promise<RecordedVerification> {
  const attempt = await prisma.executionAttempt.findUnique({ where: { id: capability.attemptId } });
  if (!attempt) throw new HttpError(404, 'ATTEMPT_NOT_FOUND', 'Execution attempt not found');
  if (attempt.status !== 'running' && attempt.status !== 'finishing') {
    throw new HttpError(409, 'ATTEMPT_STATE_CONFLICT', `Attempt is ${attempt.status}; this callback requires running or finishing`, {
      status: attempt.status,
      allowed: ['running', 'finishing'],
    });
  }

  const decision = verificationPublicationDecision(body.policy, body.status);
  if ((decision.allowed ? 'allowed' : 'blocked') !== body.publication) {
    throw new ValidationError('publication does not match what the policy decides for this status', {
      policy: body.policy, status: body.status, publication: body.publication,
    });
  }
  if (Date.parse(body.finishedAt) < Date.parse(body.startedAt)) {
    throw new ValidationError('finishedAt is before startedAt');
  }
  const sealed = sealedVerificationSettings(attempt);
  const sealedPolicy = sealed?.policy ?? DEFAULT_VERIFICATION_POLICY;
  if (body.policy !== sealedPolicy) {
    throw new HttpError(409, 'VERIFICATION_POLICY_MISMATCH', 'The evidence claims a different policy than the one sealed with the attempt', {
      sealed: sealedPolicy, claimed: body.policy,
    });
  }
  if (sealed && sealed.checks.length > 0) {
    const expected = checksHashOf(sealed.checks, sha256Hex);
    if (body.source !== 'project' || body.checksHash !== expected) {
      throw new HttpError(409, 'VERIFICATION_CHECKS_MISMATCH', 'The project defines the checks; the evidence must be for exactly those checks', {
        source: body.source,
      });
    }
  }

  const bodyHash = sha256Hex(canonicalJson(body));
  try {
    const created = await prisma.executionVerification.create({
      data: {
        attemptId: attempt.id,
        taskId: attempt.taskId,
        userId: attempt.userId,
        projectId: attempt.projectId,
        workspaceId: attempt.workspaceId,
        runId: body.runId,
        commitSha: body.commitSha,
        baseSha: body.baseSha,
        checksHash: body.checksHash,
        policy: body.policy,
        status: body.status,
        publication: body.publication,
        source: body.source,
        runner: body.runner,
        environment: body.environment,
        checks: body.checks,
        warnings: body.warnings,
        detail: body.detail,
        bodyHash,
        startedAt: new Date(body.startedAt),
        finishedAt: new Date(body.finishedAt),
      },
      select: { id: true },
    });
    logger.info({ attemptId: attempt.id, taskId: attempt.taskId, commit: body.commitSha.slice(0, 12), status: body.status, policy: body.policy }, '[verification] evidence recorded');
    return { id: created.id, attemptId: attempt.id, repeated: false };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error;
    const existing = await prisma.executionVerification.findUnique({
      where: { attemptId_commitSha_checksHash: { attemptId: attempt.id, commitSha: body.commitSha, checksHash: body.checksHash } },
      select: { id: true, bodyHash: true },
    });
    if (existing?.bodyHash === bodyHash) return { id: existing.id, attemptId: attempt.id, repeated: true };
    throw new HttpError(409, 'VERIFICATION_CONFLICT', 'Different verification evidence was already recorded for this commit and checks');
  }
}

/** `done` under a sealed require-pass policy needs a passing record for the attempt. */
export async function assertVerifiedForDone(attempt: Pick<ExecutionAttempt, 'id' | 'snapshot'>): Promise<void> {
  if (sealedVerificationPolicy(attempt) !== 'require-pass') return;
  const passed = await prisma.executionVerification.count({ where: { attemptId: attempt.id, status: 'passed', publication: 'allowed' } });
  if (passed === 0) {
    throw new HttpError(422, 'VERIFICATION_REQUIRED', 'This project requires passing verification evidence before a task can be marked done');
  }
}

// ---------------------------------------------------------------------------
// Reads and project settings (session / PAT)
// ---------------------------------------------------------------------------

export interface TaskVerificationView {
  id: string;
  attemptId: string;
  runId: string;
  commitSha: string;
  baseSha: string | null;
  checksHash: string;
  policy: string;
  status: string;
  publication: string;
  source: string;
  runner: string;
  environment: Prisma.JsonValue;
  checks: Prisma.JsonValue;
  warnings: Prisma.JsonValue;
  detail: string | null;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
}

/** The task's verification evidence, newest first. */
export async function listTaskVerifications(input: { userId: string; taskId: string; limit?: number }): Promise<{ items: TaskVerificationView[] }> {
  await assertTaskAccess(input.taskId, input.userId, 'view');
  const rows = await prisma.executionVerification.findMany({
    where: { taskId: input.taskId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: Math.min(Math.max(input.limit ?? 10, 1), 50),
  });
  return {
    items: rows.map((row) => ({
      id: row.id,
      attemptId: row.attemptId,
      runId: row.runId,
      commitSha: row.commitSha,
      baseSha: row.baseSha,
      checksHash: row.checksHash,
      policy: row.policy,
      status: row.status,
      publication: row.publication,
      source: row.source,
      runner: row.runner,
      environment: row.environment,
      checks: row.checks,
      warnings: row.warnings,
      detail: row.detail,
      startedAt: row.startedAt.toISOString(),
      finishedAt: row.finishedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export interface ProjectVerificationSettingsView {
  projectId: string;
  configured: boolean;
  settings: ProjectVerificationSettings;
  checksHash: string;
  /** W16a: sha256 of the canonical setup steps (what a run seals). */
  setupHash: string;
}

const DEFAULT_SETTINGS: ProjectVerificationSettings = {
  policy: DEFAULT_VERIFICATION_POLICY,
  checks: [],
  autoDetect: false,
  repositoryChecks: true,
  setup: [],
};

function settingsView(projectId: string, stored: ProjectVerificationSettings | null): ProjectVerificationSettingsView {
  const settings = stored ?? DEFAULT_SETTINGS;
  return {
    projectId,
    configured: stored !== null,
    settings,
    checksHash: checksHashOf(settings.checks, sha256Hex),
    setupHash: checksHashOf(settings.setup, sha256Hex),
  };
}

export async function getProjectVerificationSettings(input: { projectId: string; userId: string }): Promise<ProjectVerificationSettingsView> {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { executionSettings: true } });
  return settingsView(input.projectId, storedVerificationSettings(project?.executionSettings));
}

/**
 * Workspace owners/admins (no workspace: full project access). Strict
 * validation; audited. W16a: a body without a `setup` key (an editor that
 * predates setup steps) keeps the stored steps; `setup: []` clears them.
 */
export async function updateProjectVerificationSettings(input: { projectId: string; userId: string; body: unknown }): Promise<ProjectVerificationSettingsView> {
  const access = await assertProjectAccess(input.projectId, input.userId, 'full');
  if (access.workspaceId) await assertWorkspaceRole(access.workspaceId, input.userId, ['owner', 'admin']);
  const parsed = parseProjectVerificationSettings(input.body);
  if (!parsed.ok) throw new ValidationError('Invalid verification settings', { errors: parsed.errors });
  const keepSetup = isRecord(input.body) && !('setup' in input.body);
  const { updated, settings } = await prisma.$transaction(async (tx) => {
    const current = await tx.project.findUnique({ where: { id: input.projectId }, select: { executionSettings: true, workspaceId: true } });
    if (!current) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found');
    const base = isRecord(current.executionSettings) ? current.executionSettings : {};
    const value: ProjectVerificationSettings = keepSetup
      ? { ...parsed.value, setup: storedVerificationSettings(current.executionSettings)?.setup ?? [] }
      : parsed.value;
    // Plain JSON (strings, numbers, booleans, arrays): validated just above.
    const next = { ...base, verification: value } as unknown as Prisma.InputJsonObject;
    await tx.project.update({ where: { id: input.projectId }, data: { executionSettings: next } });
    return { updated: current, settings: value };
  });
  const view = settingsView(input.projectId, settings);
  if (updated.workspaceId) {
    try {
      await logAudit({
        workspaceId: updated.workspaceId,
        actorId: input.userId,
        action: 'project.verification_settings_updated',
        resourceType: 'project',
        resourceId: input.projectId,
        metadata: {
          policy: settings.policy,
          checks: settings.checks.length,
          checksHash: view.checksHash,
          autoDetect: settings.autoDetect,
          repositoryChecks: settings.repositoryChecks,
          setupSteps: settings.setup.length,
          setupHash: view.setupHash,
        },
      });
    } catch (error) {
      logger.warn({ err: error, projectId: input.projectId }, '[verification] audit log write failed');
    }
  }
  return view;
}
