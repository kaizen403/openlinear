import { prisma, type Prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import { redactNullable, redactText } from '../lib/redact-text';
import { assertProjectAccess } from './ownership';
import { formatOf } from './webhook-formats';

/**
 * FE-16 (W20 slice): a project-scoped export the user can keep — the
 * project, its teams and labels, and every task with its comments, run
 * metadata and verification evidence — as one versioned JSON document.
 *
 * Also (W17a/W17b): "blocked by" edges among the exported tasks and the
 * project's plans with every revision (free text redacted); (W20) its
 * recurring-issue schedules with their recent occurrences; (W19b) its
 * knowledge entries with their revision history (text redacted); (FE-14)
 * its webhook endpoints — URL origin only, events, format, digest time,
 * on/off and failure counters, never the secret — with the status of their
 * last deliveries (no bodies, responses or errors).
 *
 * Scope: the caller needs view access to the project; only that project's
 * rows are read. Excluded by design (and listed under `omitted`):
 * credentials and encrypted fields, execution logs and transcripts, audit
 * logs, other projects. Free text that could carry a pasted secret (task
 * descriptions and outcomes, comments, run errors) is redacted. Bounded:
 * at most MAX_EXPORT_TASKS tasks and, across them, the newest
 * MAX_EXPORT_COMMENTS comments, MAX_EXPORT_RUNS runs and
 * MAX_EXPORT_VERIFICATIONS verifications, plus the newest knowledge versions
 * and plan revisions; `truncated` says when anything was cut and
 * `truncation` says what. The whole bundle is built in memory, so every part
 * must stay bounded (the route is also rate limited).
 */

export const PROJECT_EXPORT_FORMAT = 'openlinear.project-export';
export const PROJECT_EXPORT_VERSION = 1;
export const MAX_EXPORT_TASKS = 5_000;
/** W20: most recent occurrences per schedule (older ones are history the tasks already carry). */
export const MAX_EXPORT_SCHEDULE_OCCURRENCES = 100;
/** FE-14: most recent deliveries per webhook endpoint. */
export const MAX_EXPORT_WEBHOOK_DELIVERIES = 20;
/** Newest rows kept across all exported tasks (comment bodies are ≤ 10,000 characters). */
export const MAX_EXPORT_COMMENTS = 20_000;
export const MAX_EXPORT_RUNS = 20_000;
export const MAX_EXPORT_VERIFICATIONS = 20_000;
/** Newest knowledge versions / plan revisions kept across the project. */
export const MAX_EXPORT_KNOWLEDGE_VERSIONS = 5_000;
export const MAX_EXPORT_PLAN_REVISIONS = 2_000;

/** Newest `max` rows (fetched newest first with one extra row), returned oldest first, and whether more existed. */
function newest<T>(rows: T[], max: number): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice(0, max).reverse(), truncated: rows.length > max };
}

function groupBy<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const list = groups.get(key(row));
    if (list) list.push(row);
    else groups.set(key(row), [row]);
  }
  return groups;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** Scheme, host and port only: webhook paths and queries often carry receiver tokens. */
function urlOrigin(raw: string): string | null {
  try {
    const origin = new URL(raw).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

export async function exportProject(input: { projectId: string; userId: string }) {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: {
      id: true, key: true, name: true, description: true, status: true, color: true, icon: true,
      startDate: true, targetDate: true, defaultAgent: true, createdAt: true, updatedAt: true,
      repository: { select: { fullName: true, defaultBranch: true } },
      teams: { select: { id: true, key: true, name: true }, orderBy: { name: 'asc' } },
      labels: { select: { id: true, name: true, color: true, priority: true }, orderBy: { name: 'asc' } },
    },
  });
  if (!project) throw new HttpError(404, 'PROJECT_NOT_FOUND', 'Project not found');
  const exporter = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, username: true } });

  const total = await prisma.task.count({ where: { projectId: input.projectId } });
  const tasks = await prisma.task.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_EXPORT_TASKS,
    select: {
      id: true, identifier: true, number: true, title: true, description: true, status: true, priority: true,
      parentId: true, teamId: true, assigneeId: true, creatorId: true, dueDate: true, model: true, agent: true,
      prUrl: true, outcome: true, archived: true, createdAt: true, updatedAt: true,
      labels: { select: { labelId: true } },
      taskAssignees: { select: { userId: true } },
    },
  });
  const taskIds = tasks.map((task) => task.id);
  // Flat, capped queries (newest first) rather than unbounded nested includes.
  const comments = newest(taskIds.length === 0 ? [] : await prisma.comment.findMany({
    where: { taskId: { in: taskIds } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_EXPORT_COMMENTS + 1,
    select: { id: true, taskId: true, userId: true, body: true, createdAt: true },
  }), MAX_EXPORT_COMMENTS);
  const runs = newest(taskIds.length === 0 ? [] : await prisma.agentRun.findMany({
    where: { taskId: { in: taskIds } },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: MAX_EXPORT_RUNS + 1,
    select: {
      id: true, taskId: true, agent: true, runner: true, model: true, status: true, startedAt: true, endedAt: true,
      costUsd: true, costBasis: true, inputTokens: true, outputTokens: true, cachedInputTokens: true,
      cacheWriteTokens: true, reasoningTokens: true, prUrl: true, errorMessage: true,
    },
  }), MAX_EXPORT_RUNS);
  const verifications = newest(taskIds.length === 0 ? [] : await prisma.executionVerification.findMany({
    where: { taskId: { in: taskIds } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_EXPORT_VERIFICATIONS + 1,
    select: { taskId: true, commitSha: true, baseSha: true, status: true, policy: true, publication: true, source: true, runner: true, checks: true, createdAt: true },
  }), MAX_EXPORT_VERIFICATIONS);
  // W17a/W17b: "blocked by" edges among the exported tasks, and the project's plans.
  const dependencies = taskIds.length === 0 ? [] : await prisma.taskDependency.findMany({
    where: { taskId: { in: taskIds }, dependsOnTaskId: { in: taskIds } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { taskId: true, dependsOnTaskId: true, createdAt: true },
  });
  const plans = await prisma.plan.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, title: true, status: true, latestRevision: true, approvedRevision: true, createdAt: true,
      tasks: { orderBy: { createdAt: 'asc' }, select: { key: true, taskId: true } },
    },
  });
  const revisions = newest(plans.length === 0 ? [] : await prisma.planRevision.findMany({
    where: { planId: { in: plans.map((plan) => plan.id) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_EXPORT_PLAN_REVISIONS + 1,
    select: { planId: true, number: true, spec: true, specHash: true, note: true, createdAt: true, approvedAt: true },
  }), MAX_EXPORT_PLAN_REVISIONS);
  const knowledge = await prisma.knowledgeEntry.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const knowledgeVersions = newest(knowledge.length === 0 ? [] : await prisma.knowledgeVersion.findMany({
    where: { entryId: { in: knowledge.map((entry) => entry.id) } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_EXPORT_KNOWLEDGE_VERSIONS + 1,
  }), MAX_EXPORT_KNOWLEDGE_VERSIONS);
  const schedules = await prisma.issueSchedule.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: {
      occurrences: {
        orderBy: { slotAt: 'desc' },
        take: MAX_EXPORT_SCHEDULE_OCCURRENCES,
        select: { slotAt: true, kind: true, outcome: true, reason: true, skippedSlots: true, taskId: true, createdAt: true },
      },
    },
  });
  const webhooks = await prisma.webhookEndpoint.findMany({
    where: { scope: 'project', projectId: input.projectId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, url: true, description: true, eventTypes: true, format: true, digestHour: true, digestTimezone: true, active: true,
      disabledAt: true, disabledReason: true, consecutiveFailures: true, lastSuccessAt: true, lastFailureAt: true, createdAt: true,
      deliveries: {
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_EXPORT_WEBHOOK_DELIVERIES,
        select: { id: true, eventType: true, status: true, attempts: true, lastStatusCode: true, lastAttemptAt: true, deliveredAt: true, redeliveries: true, createdAt: true },
      },
    },
  });
  const verificationsByTask = groupBy(verifications.rows, (record) => record.taskId);
  const commentsByTask = groupBy(comments.rows, (comment) => comment.taskId);
  const runsByTask = groupBy(runs.rows, (run) => run.taskId);
  const revisionsByPlan = groupBy([...revisions.rows].sort((a, b) => a.number - b.number), (revision) => revision.planId);
  const versionsByEntry = groupBy([...knowledgeVersions.rows].sort((a, b) => a.version - b.version), (version) => version.entryId);
  const truncation = {
    tasks: total > tasks.length,
    comments: comments.truncated,
    runs: runs.truncated,
    verifications: verifications.truncated,
    planRevisions: revisions.truncated,
    knowledgeVersions: knowledgeVersions.truncated,
  };

  const exportedAt = new Date();
  return {
    format: PROJECT_EXPORT_FORMAT,
    version: PROJECT_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    exportedBy: exporter ? { id: exporter.id, username: exporter.username } : { id: input.userId, username: null },
    omitted: [
      'credentials, tokens and encrypted fields',
      'execution logs and agent transcripts',
      'audit logs',
      'webhook secrets, webhook URLs beyond their origin, delivery bodies and responses',
      'other projects',
    ],
    truncated: Object.values(truncation).some(Boolean),
    truncation,
    taskCount: total,
    project: {
      id: project.id,
      key: project.key,
      name: project.name,
      description: redactNullable(project.description),
      status: project.status,
      color: project.color,
      icon: project.icon,
      startDate: iso(project.startDate),
      targetDate: iso(project.targetDate),
      defaultAgent: project.defaultAgent,
      repository: project.repository ? { fullName: project.repository.fullName, defaultBranch: project.repository.defaultBranch } : null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    teams: project.teams,
    labels: project.labels,
    dependencies: dependencies.map((edge) => ({ taskId: edge.taskId, blockedByTaskId: edge.dependsOnTaskId, createdAt: edge.createdAt.toISOString() })),
    plans: plans.map((plan) => ({
      id: plan.id,
      title: redactText(plan.title),
      status: plan.status,
      latestRevision: plan.latestRevision,
      approvedRevision: plan.approvedRevision,
      createdAt: plan.createdAt.toISOString(),
      revisions: (revisionsByPlan.get(plan.id) ?? []).map((revision) => ({
        number: revision.number,
        specHash: revision.specHash,
        note: redactNullable(revision.note),
        createdAt: revision.createdAt.toISOString(),
        approvedAt: iso(revision.approvedAt),
        spec: redactPlanSpec(revision.spec),
      })),
      tasks: plan.tasks,
    })),
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      title: redactText(schedule.title),
      description: redactNullable(schedule.description),
      priority: schedule.priority,
      labelIds: schedule.labelIds,
      assigneeId: schedule.assigneeId,
      cadence: schedule.cadence,
      weekday: schedule.weekday,
      dayOfMonth: schedule.dayOfMonth,
      hour: schedule.hour,
      minute: schedule.minute,
      timezone: schedule.timezone,
      nextRunAt: schedule.nextRunAt.toISOString(),
      lastRunAt: iso(schedule.lastRunAt),
      pausedAt: iso(schedule.pausedAt),
      pauseReason: schedule.pauseReason,
      ownerId: schedule.ownerId,
      createdById: schedule.createdById,
      createdAt: schedule.createdAt.toISOString(),
      occurrences: schedule.occurrences.map((occurrence) => ({
        slotAt: occurrence.slotAt.toISOString(),
        kind: occurrence.kind,
        outcome: occurrence.outcome,
        reason: occurrence.reason,
        skippedSlots: occurrence.skippedSlots,
        taskId: occurrence.taskId,
        createdAt: occurrence.createdAt.toISOString(),
      })),
    })),
    knowledge: knowledge.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: redactText(entry.title),
      body: redactText(entry.body),
      status: entry.status,
      source: entry.source,
      sourceRef: entry.sourceRef,
      version: entry.version,
      expiresAt: iso(entry.expiresAt),
      createdById: entry.createdById,
      approvedById: entry.approvedById,
      approvedAt: iso(entry.approvedAt),
      retractedById: entry.retractedById,
      retractedAt: iso(entry.retractedAt),
      retractReason: redactNullable(entry.retractReason),
      createdAt: entry.createdAt.toISOString(),
      versions: (versionsByEntry.get(entry.id) ?? []).map((version) => ({
        version: version.version,
        kind: version.kind,
        title: redactText(version.title),
        body: redactText(version.body),
        status: version.status,
        change: version.change,
        note: redactNullable(version.note),
        editedById: version.editedById,
        createdAt: version.createdAt.toISOString(),
      })),
    })),
    webhooks: webhooks.map((endpoint) => ({
      id: endpoint.id,
      origin: urlOrigin(endpoint.url),
      description: redactNullable(endpoint.description),
      eventTypes: endpoint.eventTypes,
      format: formatOf(endpoint.format),
      digestHour: endpoint.digestHour,
      digestTimezone: endpoint.digestTimezone,
      active: endpoint.active,
      disabledAt: iso(endpoint.disabledAt),
      disabledReason: endpoint.disabledReason,
      consecutiveFailures: endpoint.consecutiveFailures,
      lastSuccessAt: iso(endpoint.lastSuccessAt),
      lastFailureAt: iso(endpoint.lastFailureAt),
      createdAt: endpoint.createdAt.toISOString(),
      recentDeliveries: endpoint.deliveries.map((delivery) => ({
        id: delivery.id,
        eventType: delivery.eventType,
        status: delivery.status,
        attempts: delivery.attempts,
        lastStatusCode: delivery.lastStatusCode,
        lastAttemptAt: iso(delivery.lastAttemptAt),
        deliveredAt: iso(delivery.deliveredAt),
        redeliveries: delivery.redeliveries,
        createdAt: delivery.createdAt.toISOString(),
      })),
    })),
    tasks: tasks.map((task) => ({
      id: task.id,
      identifier: task.identifier,
      number: task.number,
      title: redactText(task.title),
      description: redactNullable(task.description),
      status: task.status,
      priority: task.priority,
      parentId: task.parentId,
      teamId: task.teamId,
      assigneeId: task.assigneeId,
      assigneeIds: task.taskAssignees.map((row) => row.userId),
      creatorId: task.creatorId,
      labelIds: task.labels.map((row) => row.labelId),
      dueDate: iso(task.dueDate),
      model: task.model,
      agent: task.agent,
      prUrl: task.prUrl,
      outcome: redactNullable(task.outcome),
      archived: task.archived,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      comments: (commentsByTask.get(task.id) ?? []).map((comment) => ({
        id: comment.id,
        authorId: comment.userId,
        body: redactText(comment.body),
        createdAt: comment.createdAt.toISOString(),
      })),
      runs: (runsByTask.get(task.id) ?? []).map((run) => ({
        id: run.id,
        agent: run.agent,
        runner: run.runner,
        model: run.model,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        endedAt: iso(run.endedAt),
        costUsd: run.costUsd === null ? null : Number(run.costUsd),
        costBasis: run.costBasis,
        tokens: {
          input: run.inputTokens,
          output: run.outputTokens,
          cachedInput: run.cachedInputTokens,
          cacheWrite: run.cacheWriteTokens,
          reasoning: run.reasoningTokens,
        },
        prUrl: run.prUrl,
        error: redactNullable(run.errorMessage),
      })),
      verifications: (verificationsByTask.get(task.id) ?? []).map((record) => ({
        commitSha: record.commitSha,
        baseSha: record.baseSha,
        status: record.status,
        policy: record.policy,
        publication: record.publication,
        source: record.source,
        runner: record.runner,
        checks: Array.isArray(record.checks)
          ? record.checks.flatMap((check) => {
            if (check === null || typeof check !== 'object' || Array.isArray(check)) return [];
            // The evidence's log tail is agent/tool output: not exported (see `omitted`).
            return [{ name: String(check.name ?? ''), status: String(check.status ?? ''), required: check.required !== false, exitCode: typeof check.exitCode === 'number' ? check.exitCode : null }];
          })
          : [],
        recordedAt: record.createdAt.toISOString(),
      })),
    })),
  };
}

/** Free text in a stored plan spec (summary, titles, descriptions, checks) may hold a pasted secret. */
function redactPlanSpec(value: Prisma.JsonValue): Prisma.JsonValue {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactPlanSpec);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'key' || key === 'blockedBy' || key === 'estimate' || key === 'priority' || key === 'risk' ? entry ?? null : redactPlanSpec(entry ?? null)]));
  }
  return value;
}

export function exportFileName(projectKey: string | null, projectName: string, at: Date): string {
  const base = (projectKey ?? projectName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  return `openlinear-${base}-${at.toISOString().slice(0, 10)}.json`;
}
