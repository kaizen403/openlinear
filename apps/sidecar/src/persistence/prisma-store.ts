import { decryptToken, Prisma, prisma, type ActivityAction } from '@openlinear/db';
import { authorizeTaskAccess } from '../auth/task-access';
import { publishTaskEvent } from '../events/publisher';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { getExecutionSettings } from '../services/execution-settings';
import type {
  AttemptContext,
  ExecutionSettings,
  RefreshPullRequestResult,
  SidecarStore,
  TaskProjection,
  TaskSnapshot,
} from './store';

/**
 * Development/test persistence (tests, `--with-cloud-api` against a loopback
 * `*_test` database). The fenced writes below are the W01 single-task
 * semantics the control plane now applies server-side for production
 * (apps/api/src/services/execution-control.ts); both are tested. Authorization
 * is still delegated to the control plane through `auth/task-access`.
 */

interface LabelRelation {
  label: { id: string; name: string; color: string };
}

function flatten<T extends { labels: LabelRelation[] }>(task: T): Omit<T, 'labels'> & { labels: LabelRelation['label'][] } {
  const { labels, ...rest } = task;
  return { ...rest, labels: labels.map((relation) => relation.label) };
}

async function recordActivity(input: {
  taskId: string;
  userId: string;
  action: ActivityAction;
  payload: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    const scope = await prisma.task.findUnique({ where: { id: input.taskId }, select: { teamId: true, projectId: true } });
    await prisma.activityLog.create({
      data: {
        taskId: input.taskId,
        teamId: scope?.teamId ?? null,
        projectId: scope?.projectId ?? null,
        userId: input.userId,
        action: input.action,
        payload: input.payload,
      },
    });
  } catch (err) {
    logger.warn({ err, action: input.action, taskId: input.taskId }, '[activity] failed to log — continuing');
  }
}

async function decryptUserToken(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { accessToken: true } });
  return decryptToken(user?.accessToken ?? null);
}

const COMPARE_URL_PATTERN = /github\.com\/([^/]+)\/([^/]+)\/compare\/.+\.\.\.(.+)$/;

export function createPrismaStore(): SidecarStore {
  return {
    mode: 'prisma',

    async startAttempt(input) {
      const settings: ExecutionSettings = await getExecutionSettings(input.userId);
      const rejected = input.admit(settings);
      if (rejected) return { ok: false, error: rejected };

      const authority = await authorizeTaskAccess(input.credential, input.taskId, 'write');
      if (authority.archived) throw new HttpError(409, 'TASK_ARCHIVED', 'Archived tasks cannot execute');
      // The In Progress column alone is not a running execution; a bound session is.
      const held = await prisma.task.findUnique({ where: { id: input.taskId }, select: { status: true, sessionId: true } });
      if (held?.status === 'in_progress' && held.sessionId !== null) throw new HttpError(409, 'TASK_ALREADY_RUNNING', 'Task is already executing');
      if (!input.allowBlocked) {
        // W17a: same gate as the API's startExecutionAttempt.
        const open = await prisma.taskDependency.findMany({
          where: { taskId: input.taskId, dependsOnTask: { status: { not: 'done' } } },
          select: { dependsOnTask: { select: { id: true, identifier: true, title: true, status: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (open.length > 0) {
          const blockers = open.map((row) => row.dependsOnTask);
          const names = blockers.slice(0, 3).map((blocker) => blocker.identifier ?? `"${blocker.title.slice(0, 60)}"`).join(', ');
          throw new HttpError(409, 'TASK_BLOCKED', `This task is blocked by ${names}${blockers.length > 3 ? ` and ${blockers.length - 3} more` : ''}. Finish ${blockers.length === 1 ? 'it' : 'them'} first, or run it anyway.`, { blockers });
        }
      }
      const task = await prisma.task.findUnique({
        where: { id: input.taskId },
        include: {
          project: { include: { repository: true } },
          labels: { include: { label: true } },
        },
      });
      if (!task) return { ok: false, error: 'Task not found' };
      const snapshot = task as unknown as TaskSnapshot;
      if (authority.id !== snapshot.id
        || authority.projectId !== (snapshot.projectId ?? snapshot.project?.id ?? null)
        || authority.teamId !== snapshot.teamId || authority.creatorId !== snapshot.creatorId) {
        throw new HttpError(409, 'TASK_SELECTION_CHANGED', 'Task access scope changed while execution was checked');
      }
      const attempt: AttemptContext = {
        taskId: input.taskId,
        userId: input.userId,
        attemptId: null,
        client: null,
        credential: input.credential,
      };
      return { ok: true, attempt, task: snapshot, authority, settings };
    },

    async getGitCredential(attempt) {
      return decryptUserToken(attempt.userId);
    },

    async claimAttempt(attempt, input) {
      let agentRunId: string | null = null;
      try {
        const row = await prisma.agentRun.create({
          data: { taskId: attempt.taskId, userId: attempt.userId, agent: input.runner, model: input.model, status: 'running' },
          select: { id: true },
        });
        agentRunId = row.id;
        await recordActivity({
          taskId: attempt.taskId,
          userId: attempt.userId,
          action: 'agent_run_started',
          payload: { agentRunId: row.id, agent: input.runner, model: input.model },
        });
      } catch (err) {
        logger.error({ err, taskId: attempt.taskId }, '[AgentRun] failed to create row — execution will continue without capture');
      }
      const task = await prisma.task.update({
        where: { id: attempt.taskId },
        data: {
          status: 'in_progress',
          sessionId: input.sessionId,
          executionStartedAt: input.executionStartedAt,
          executionPausedAt: null,
          executionElapsedMs: 0,
          executionProgress: 0,
        },
        include: { labels: { include: { label: true } } },
      });
      await prisma.task.update({ where: { id: attempt.taskId }, data: { batchId: null } });
      return { agentRunId, task: flatten(task) as unknown as TaskProjection };
    },

    async writeTaskStatus(_attempt, input) {
      const fence = input.status !== 'in_progress' ? input.fence : null;
      const task = await prisma.task.update({
        where: {
          id: input.taskId,
          ...(fence ? {
            sessionId: fence.sessionId,
            status: 'in_progress' as const,
            ...(fence.projectId !== undefined ? { projectId: fence.projectId, teamId: fence.teamId, creatorId: fence.creatorId } : {}),
          } : {}),
        },
        data: { status: input.status, sessionId: input.sessionId, ...input.executionData },
        include: { labels: { include: { label: true } } },
      });
      return flatten(task) as unknown as TaskProjection;
    },

    async persistLogs(_attempt, input) {
      const { fence } = input;
      try {
        await prisma.$executeRaw`
          UPDATE tasks SET "executionLogs" = ${JSON.stringify(input.logs)}::jsonb WHERE id = ${input.taskId}
            AND status = ${fence.terminalStatus ?? 'in_progress'}
            AND "sessionId" IS NOT DISTINCT FROM ${fence.terminalStatus ? null : fence.sessionId}
            AND (${fence.projectId === undefined} OR (
              "projectId" IS NOT DISTINCT FROM ${fence.projectId ?? null}
              AND "teamId" IS NOT DISTINCT FROM ${fence.teamId}
              AND "creatorId" IS NOT DISTINCT FROM ${fence.creatorId}
            ))
        `;
      } catch (error) {
        logger.error({ err: error, taskId: input.taskId }, `[Execution] Failed to persist logs for task ${input.taskId.slice(0, 8)}`);
      }
    },

    async finalizeRun(_attempt, input) {
      const data: Prisma.AgentRunUpdateInput = { endedAt: new Date(), status: input.status };
      const usage = input.usage;
      if (usage.costUsd !== undefined && usage.costUsd > 0) data.costUsd = new Prisma.Decimal(usage.costUsd.toFixed(6));
      if (usage.inputTokens !== undefined && usage.inputTokens > 0) data.inputTokens = usage.inputTokens;
      if (usage.outputTokens !== undefined && usage.outputTokens > 0) data.outputTokens = usage.outputTokens;
      if (usage.cachedInputTokens !== undefined) data.cachedInputTokens = usage.cachedInputTokens;
      if (usage.cacheWriteTokens !== undefined) data.cacheWriteTokens = usage.cacheWriteTokens;
      if (usage.reasoningTokens !== undefined) data.reasoningTokens = usage.reasoningTokens;
      if (usage.costBasis !== undefined) data.costBasis = usage.costBasis;
      if (input.prUrl) data.prUrl = input.prUrl;
      if (input.errorMessage) data.errorMessage = input.errorMessage.slice(0, 1000);
      await prisma.agentRun.update({ where: { id: input.agentRunId }, data });
      if (input.userId) {
        await recordActivity({
          taskId: input.taskId,
          userId: input.userId,
          action: 'agent_run_completed',
          payload: {
            agentRunId: input.agentRunId,
            status: input.status,
            ...(input.prUrl ? { prUrl: input.prUrl } : {}),
            ...(input.errorMessage ? { errorMessage: input.errorMessage.slice(0, 500) } : {}),
            ...(usage.reasoningTokens ? { reasoningTokens: usage.reasoningTokens } : {}),
            ...(usage.cachedInputTokens ? { cacheReadTokens: usage.cachedInputTokens } : {}),
            ...(usage.cacheWriteTokens ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
          },
        });
      }
    },

    async authorizePublication(attempt, input) {
      const authority = await authorizeTaskAccess(attempt?.credential ?? null, input.taskId, 'write');
      const { fence } = input;
      if (authority.archived || (fence.projectId !== undefined && (
        authority.projectId !== fence.projectId || authority.teamId !== fence.teamId || authority.creatorId !== fence.creatorId
      ))) {
        throw new Error('Task access scope changed before publication');
      }
      return input.currentToken;
    },

    async acknowledgeCancellation() {
      // The provider stop receipt is enforced locally; nothing to record.
    },

    async relayEvents() {
      return { cancelRequested: false };
    },

    async heartbeat() {
      return { cancelRequested: false };
    },

    async closeAttempt(attempt) {
      attempt.closed = true;
    },

    async readPersistedLogs(credential, taskId) {
      await authorizeTaskAccess(credential, taskId, 'full');
      const result = await prisma.$queryRaw<Array<{ executionLogs: unknown }>>`
        SELECT "executionLogs" FROM tasks WHERE id = ${taskId}
      `;
      const logs = result[0]?.executionLogs;
      return Array.isArray(logs) ? (logs as Awaited<ReturnType<SidecarStore['readPersistedLogs']>>) : [];
    },

    async refreshPullRequest(credential, taskId): Promise<RefreshPullRequestResult> {
      await authorizeTaskAccess(credential, taskId, 'write');
      const task = await prisma.task.findUnique({ where: { id: taskId }, select: { prUrl: true, batchId: true } });
      if (!task) throw new HttpError(404, 'TASK_NOT_FOUND', 'Task not found');
      if (!task.prUrl || !task.prUrl.includes('/compare/')) return { prUrl: task.prUrl, refreshed: false };
      const match = task.prUrl.match(COMPARE_URL_PATTERN);
      if (!match) return { prUrl: task.prUrl, refreshed: false };
      const [, owner, repo, rawBranch] = match;
      const branch = decodeURIComponent(rawBranch);
      let accessToken: string | null = null;
      try {
        accessToken = credential ? await decryptUserToken(credential.principal.userId) : null;
      } catch (err) {
        logger.error({ err }, '[execution] failed to decrypt access token');
        accessToken = null;
      }
      if (!accessToken) throw new HttpError(400, 'GITHUB_NOT_LINKED', 'GitHub authentication required to refresh PR status');
      const query = new URLSearchParams({ head: `${owner}:${branch}`, state: 'all', per_page: '1' });
      const response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${query.toString()}`,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/vnd.github.v3+json' } },
      );
      if (!response.ok) throw new HttpError(502, 'GITHUB_REQUEST_FAILED', 'GitHub API request failed');
      const pulls = (await response.json()) as Array<{ html_url: string }>;
      if (pulls.length === 0) return { prUrl: task.prUrl, refreshed: false, message: 'No PR found for this branch yet' };
      const newPrUrl = pulls[0].html_url;
      const updated = await prisma.task.update({
        where: { id: taskId },
        data: { prUrl: newPrUrl },
        include: {
          labels: { include: { label: true } },
          team: { select: { id: true, name: true, key: true, color: true } },
          project: { select: { id: true, name: true, status: true, color: true } },
        },
      });
      if (task.batchId) {
        await prisma.task.updateMany({ where: { batchId: task.batchId, prUrl: task.prUrl }, data: { prUrl: newPrUrl } });
      }
      publishTaskEvent(taskId, 'task:updated', flatten(updated), { ownerUserId: credential?.principal.userId ?? null });
      return { prUrl: newPrUrl, refreshed: true };
    },

    async recordRecoveryOutcome(run, outcome) {
      await prisma.task.update({
        where: { id: run.taskId },
        data: {
          ...(outcome === 'failed' ? { status: 'cancelled' as const } : {}),
          outcome: `sidecar_recovery_${outcome}`,
        },
      });
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: outcome === 'failed' ? 'failed' : 'running',
          errorMessage: outcome === 'failed' ? 'sidecar_restart_orphan' : null,
        },
      });
    },
  };
}
