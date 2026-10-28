import { randomUUID } from 'node:crypto';
import { Prisma, prisma, type WebhookEndpoint } from '@openlinear/db';
import { HttpError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { logger } from '../logger';
import { canonicalTimeZone, isoLocalDate, nextSlotAfter, previousSlotAtOrBefore, type ScheduleRule } from './schedule-slots';
import { disableEndpointTx, notifyEndpointDisabled, type DisabledEndpoint } from './webhook-delivery';
import { ownerMayManage, renderDeliveryBody } from './webhook-events';
import { formatOf, type DigestCounts, type MessageContext } from './webhook-formats';

/**
 * FE-14 follow-up: the `digest.daily` webhook event. See
 * docs/reports/revamp-2026-10-26/webhooks.md §11.
 *
 * An endpoint subscribed to `digest.daily` gets one summary a day at the
 * hour it chose, in its IANA time zone (slot math from schedule-slots.ts, so
 * daylight-saving days behave like recurring issues: a missing hour fires
 * after the jump, a repeated one fires once). The summary covers the slot's
 * window — from the previous day's slot to this one (23, 24 or 25 hours) —
 * for the endpoint's project, or for the workspace's projects its owner can
 * see:
 *
 *   issues created / completed in the window, issues blocked now,
 *   agent runs that ended in the window (succeeded / failed),
 *   plans awaiting review now, knowledge proposals waiting now.
 *
 * Exactly one digest per (endpoint, local date): the delivery's event id is
 * `digest.daily:<YYYY-MM-DD>` (the slot's local date) and deliveries are
 * unique per (endpoint, event id). The sweep claims each due endpoint with
 * `FOR UPDATE SKIP LOCKED`, inserts the delivery with ON CONFLICT DO NOTHING
 * and moves `digestNextAt` to the next slot in the same transaction, so a
 * second worker skips the row, a re-run after a crash redoes the whole
 * transaction, and even a moved schedule (new hour or zone on a day that
 * already had its digest) cannot produce a second one for that date. After
 * downtime only the latest due slot gets a digest (missed days are not
 * replayed). The delivery then takes the normal path: claimed by the
 * delivery worker, signed, retried, shown in the history, in the endpoint's
 * format.
 */

export const DIGEST_EVENT_TYPE = 'digest.daily';
export const DEFAULT_DIGEST_HOUR = 9;
export const DEFAULT_DIGEST_TIMEZONE = 'UTC';
/** Endpoints handled per sweep (each is one short transaction). */
const DIGEST_SWEEP_LIMIT = 50;
/** Workspace digests: projects read, and listed (most active first). */
const DIGEST_WORKSPACE_PROJECT_LIMIT = 500;
export const DIGEST_LISTED_PROJECTS = 20;
const DAY_MS = 24 * 3_600_000;

function digestRule(hour: number, timezone: string): ScheduleRule {
  return { cadence: 'daily', hour, minute: 0, timezone };
}

/** One digest per endpoint and local date: the key of the unique (endpoint, event) delivery. */
export function digestEventId(localDate: string): string {
  return `${DIGEST_EVENT_TYPE}:${localDate}`;
}

export interface DigestSlot {
  /** The latest digest time at or before `now`. */
  slotAt: Date;
  /** The previous day's digest time: the window is [since, slotAt). */
  since: Date;
  /** `YYYY-MM-DD` of the slot in the endpoint's zone. */
  localDate: string;
  /** The digest time after `now`. */
  nextAt: Date;
}

export function digestSlot(hour: number, timezone: string, now: Date): DigestSlot {
  const rule = digestRule(hour, timezone);
  const slotAt = previousSlotAtOrBefore(rule, now);
  return {
    slotAt,
    since: previousSlotAtOrBefore(rule, new Date(slotAt.getTime() - 1)),
    localDate: isoLocalDate(slotAt, timezone),
    nextAt: nextSlotAfter(rule, now),
  };
}

/** The canonical IANA name, or 400 VALIDATION_ERROR. */
export function resolveDigestTimeZone(value: string): string {
  const timezone = canonicalTimeZone(value);
  if (!timezone) {
    throw new HttpError(400, 'VALIDATION_ERROR', `Unknown time zone "${value}"; use an IANA name such as Europe/Berlin`, { field: 'digestTimezone' });
  }
  return timezone;
}

export interface DigestSettings {
  digestHour: number | null;
  digestTimezone: string | null;
  digestNextAt: Date | null;
}

/**
 * The digest columns after a create or an update. An hour or zone given
 * without the other gets the default for the missing one; subscribing
 * without either uses 09:00 UTC. `digestNextAt` is set while the endpoint
 * is on and subscribed, and kept when nothing about the schedule changed
 * (so editing a description does not move today's digest).
 */
export function digestSettings(input: {
  eventTypes: readonly string[];
  active: boolean;
  /** Given in the request (undefined: unchanged). */
  hour?: number;
  /** Given in the request, canonical (undefined: unchanged). */
  timezone?: string;
  previous?: Pick<WebhookEndpoint, 'digestHour' | 'digestTimezone' | 'digestNextAt' | 'eventTypes' | 'active'>;
  now: Date;
}): DigestSettings {
  const subscribed = input.eventTypes.includes(DIGEST_EVENT_TYPE);
  let hour = input.hour ?? input.previous?.digestHour ?? null;
  let timezone = input.timezone ?? input.previous?.digestTimezone ?? null;
  if (subscribed || hour !== null || timezone !== null) {
    hour ??= DEFAULT_DIGEST_HOUR;
    timezone ??= DEFAULT_DIGEST_TIMEZONE;
  }
  if (!subscribed || !input.active || hour === null || timezone === null) return { digestHour: hour, digestTimezone: timezone, digestNextAt: null };
  const previous = input.previous;
  const unchanged = previous?.active === true && previous.eventTypes.includes(DIGEST_EVENT_TYPE)
    && previous.digestNextAt !== null && previous.digestHour === hour && previous.digestTimezone === timezone;
  return {
    digestHour: hour,
    digestTimezone: timezone,
    digestNextAt: unchanged && previous.digestNextAt ? previous.digestNextAt : nextSlotAfter(digestRule(hour, timezone), input.now),
  };
}

// ── Numbers ────────────────────────────────────────────────────────────────

type Db = Prisma.TransactionClient | typeof prisma;
type Count = bigint | number | null;

interface CountRow {
  project_id: string;
  created: Count;
  completed: Count;
  blocked: Count;
  runs_succeeded: Count;
  runs_failed: Count;
  plans_awaiting: Count;
  knowledge_proposed: Count;
}

/** `timestamp(3)` columns hold UTC (Prisma's convention): bind bounds as UTC literals. */
const ts = (date: Date) => Prisma.sql`${date.toISOString()}::timestamp(3)`;
const n = (value: Count) => Number(value ?? 0);

/**
 * Digest numbers per project, in one statement. Definitions match project
 * insights: "completed" is an issue done now whose last recorded move to
 * done (a status change, or an execution attempt ending as done) is in the
 * window; "blocked" is an open, unarchived issue with a blocker that is not
 * done; "awaiting review" is a draft plan never approved, or one with a
 * revision newer than the approved one. Runs count by when they ended.
 */
export async function digestCounts(db: Db, projectIds: readonly string[], since: Date, until: Date): Promise<Map<string, DigestCounts>> {
  const out = new Map<string, DigestCounts>();
  if (projectIds.length === 0) return out;
  const ids = [...projectIds];
  // Every move to done bumps updatedAt; a day of slack covers the activity row written just after.
  const prefilter = new Date(since.getTime() - DAY_MS);
  const rows = await db.$queryRaw<CountRow[]>`
    WITH scope AS (SELECT unnest(${ids}::text[]) AS project_id),
    created AS (
      SELECT t."projectId" AS project_id, COUNT(*) AS n FROM "tasks" t
       WHERE t."projectId" = ANY(${ids}::text[]) AND t."createdAt" >= ${ts(since)} AND t."createdAt" < ${ts(until)}
       GROUP BY 1
    ),
    completed AS (
      SELECT c.project_id, COUNT(*) AS n FROM (
        SELECT t."projectId" AS project_id,
               GREATEST(
                 (SELECT MAX(al."createdAt") FROM "activity_logs" al
                   WHERE al."taskId" = t."id" AND al."action" = 'task_status_changed' AND al."payload"->>'to' = 'done'),
                 (SELECT MAX(a."finishedAt") FROM "execution_attempts" a
                   WHERE a."taskId" = t."id" AND a."terminalStatus" = 'done')
               ) AS done_at
          FROM "tasks" t
         WHERE t."projectId" = ANY(${ids}::text[]) AND t."status" = 'done' AND t."updatedAt" >= ${ts(prefilter)}
      ) c
       WHERE c.done_at >= ${ts(since)} AND c.done_at < ${ts(until)}
       GROUP BY 1
    ),
    blocked AS (
      SELECT t."projectId" AS project_id, COUNT(*) AS n FROM "tasks" t
       WHERE t."projectId" = ANY(${ids}::text[]) AND t."archived" = false AND t."status" IN ('todo', 'in_progress')
         AND EXISTS (
           SELECT 1 FROM "task_dependencies" d JOIN "tasks" b ON b."id" = d."dependsOnTaskId"
            WHERE d."taskId" = t."id" AND b."status" <> 'done'
         )
       GROUP BY 1
    ),
    runs AS (
      SELECT t."projectId" AS project_id,
             COUNT(*) FILTER (WHERE r."status"::text = 'succeeded') AS succeeded,
             COUNT(*) FILTER (WHERE r."status"::text = 'failed') AS failed
        FROM "agent_runs" r JOIN "tasks" t ON t."id" = r."taskId"
       WHERE t."projectId" = ANY(${ids}::text[]) AND r."endedAt" >= ${ts(since)} AND r."endedAt" < ${ts(until)}
         AND r."status"::text IN ('succeeded', 'failed')
       GROUP BY 1
    ),
    plans AS (
      SELECT p."projectId" AS project_id, COUNT(*) AS n FROM "plans" p
       WHERE p."projectId" = ANY(${ids}::text[]) AND p."status" <> 'archived'
         AND CASE WHEN p."approvedRevision" IS NULL THEN p."status" = 'draft' ELSE p."latestRevision" > p."approvedRevision" END
       GROUP BY 1
    ),
    knowledge AS (
      SELECT k."projectId" AS project_id, COUNT(*) AS n FROM "knowledge_entries" k
       WHERE k."projectId" = ANY(${ids}::text[]) AND k."status" = 'proposed'
       GROUP BY 1
    )
    SELECT s.project_id, cr.n AS created, co.n AS completed, bl.n AS blocked,
           ru.succeeded AS runs_succeeded, ru.failed AS runs_failed, pl.n AS plans_awaiting, kn.n AS knowledge_proposed
      FROM scope s
      LEFT JOIN created cr ON cr.project_id = s.project_id
      LEFT JOIN completed co ON co.project_id = s.project_id
      LEFT JOIN blocked bl ON bl.project_id = s.project_id
      LEFT JOIN runs ru ON ru.project_id = s.project_id
      LEFT JOIN plans pl ON pl.project_id = s.project_id
      LEFT JOIN knowledge kn ON kn.project_id = s.project_id`;
  for (const row of rows) {
    out.set(row.project_id, {
      issues: { created: n(row.created), completed: n(row.completed), blocked: n(row.blocked) },
      runs: { succeeded: n(row.runs_succeeded), failed: n(row.runs_failed) },
      plansAwaitingReview: n(row.plans_awaiting),
      knowledgeProposals: n(row.knowledge_proposed),
    });
  }
  return out;
}

function emptyCounts(): DigestCounts {
  return { issues: { created: 0, completed: 0, blocked: 0 }, runs: { succeeded: 0, failed: 0 }, plansAwaitingReview: 0, knowledgeProposals: 0 };
}

function addCounts(total: DigestCounts, each: DigestCounts): DigestCounts {
  return {
    issues: { created: total.issues.created + each.issues.created, completed: total.issues.completed + each.issues.completed, blocked: total.issues.blocked + each.issues.blocked },
    runs: { succeeded: total.runs.succeeded + each.runs.succeeded, failed: total.runs.failed + each.runs.failed },
    plansAwaitingReview: total.plansAwaitingReview + each.plansAwaitingReview,
    knowledgeProposals: total.knowledgeProposals + each.knowledgeProposals,
  };
}

function activity(counts: DigestCounts): number {
  return counts.issues.created + counts.issues.completed + counts.issues.blocked + counts.runs.succeeded + counts.runs.failed
    + counts.plansAwaitingReview + counts.knowledgeProposals;
}

interface DigestContent {
  workspaceId: string | null;
  data: Record<string, unknown>;
  context: MessageContext;
}

type DigestEndpoint = Pick<WebhookEndpoint, 'id' | 'scope' | 'projectId' | 'workspaceId' | 'ownerId' | 'digestHour' | 'digestTimezone'>;

/**
 * What the digest says for an endpoint: its project, or the workspace's
 * projects minus those that explicitly deny the endpoint's owner (what a
 * workspace member may read, as in workspace insights).
 */
export async function digestContent(db: Db, endpoint: DigestEndpoint, slot: Pick<DigestSlot, 'since' | 'slotAt' | 'localDate'>): Promise<DigestContent> {
  const head = {
    date: slot.localDate,
    timezone: endpoint.digestTimezone ?? DEFAULT_DIGEST_TIMEZONE,
    hour: endpoint.digestHour ?? DEFAULT_DIGEST_HOUR,
    since: slot.since.toISOString(),
    until: slot.slotAt.toISOString(),
  };
  if (endpoint.scope === 'project' && endpoint.projectId) {
    const project = await db.project.findUnique({ where: { id: endpoint.projectId }, select: { id: true, key: true, name: true, workspaceId: true } });
    const counts = (await digestCounts(db, [endpoint.projectId], slot.since, slot.slotAt)).get(endpoint.projectId) ?? emptyCounts();
    return {
      workspaceId: project?.workspaceId ?? null,
      data: { digest: { ...head, ...counts }, project: project ? { id: project.id, key: project.key, name: project.name } : { id: endpoint.projectId } },
      context: { projectName: project?.name ?? null, workspaceName: null },
    };
  }
  const workspaceId = endpoint.workspaceId ?? '';
  const workspace = await db.workspace.findUnique({ where: { id: workspaceId }, select: { id: true, name: true } });
  const projects = await db.$queryRaw<Array<{ id: string; key: string | null; name: string }>>`
    SELECT wp."id", wp."key", wp."name" FROM "linear_projects" wp
     WHERE wp."workspaceId" = ${workspaceId}
       AND NOT EXISTS (SELECT 1 FROM "project_access" wd WHERE wd."projectId" = wp."id" AND wd."userId" = ${endpoint.ownerId} AND wd."permission" = 'deny')
     ORDER BY wp."createdAt", wp."id"
     LIMIT ${DIGEST_WORKSPACE_PROJECT_LIMIT}`;
  const counts = await digestCounts(db, projects.map((project) => project.id), slot.since, slot.slotAt);
  let total = emptyCounts();
  const listed: Array<{ id: string; key: string | null; name: string; counts: DigestCounts }> = [];
  for (const project of projects) {
    const each = counts.get(project.id) ?? emptyCounts();
    total = addCounts(total, each);
    if (activity(each) > 0) listed.push({ ...project, counts: each });
  }
  listed.sort((a, b) => activity(b.counts) - activity(a.counts) || a.name.localeCompare(b.name));
  return {
    workspaceId,
    data: {
      digest: { ...head, ...total, projectCount: projects.length },
      workspace: workspace ? { id: workspace.id, name: workspace.name } : { id: workspaceId },
      projects: listed.slice(0, DIGEST_LISTED_PROJECTS).map((project) => ({ id: project.id, key: project.key, name: project.name, ...project.counts })),
    },
    context: { projectName: null, workspaceName: workspace?.name ?? null },
  };
}

// ── Sweep ──────────────────────────────────────────────────────────────────

type DigestOutcome = 'recorded' | 'duplicate' | 'notClaimed' | 'disabled';

export interface DigestSweepResult extends Record<DigestOutcome, number> {
  examined: number;
  failed: number;
}

async function recordDigest(candidate: Pick<WebhookEndpoint, 'id' | 'scope' | 'projectId' | 'workspaceId' | 'ownerId'>, now: Date): Promise<DigestOutcome> {
  // Rights are read before the claim (global client), so the transaction only
  // uses its own connection; the claimed row must still have this owner.
  const mayManage = await ownerMayManage(candidate);
  const result = await transactionWithEvents(async (tx): Promise<{ outcome: DigestOutcome; disabled?: DisabledEndpoint }> => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "webhook_endpoints" WHERE id = ${candidate.id} FOR UPDATE SKIP LOCKED`;
    if (locked.length === 0) return { outcome: 'notClaimed' };
    // Due-ness is re-read after the lock (in JS: raw timestamp parameters would be compared in the session zone).
    const endpoint = await tx.webhookEndpoint.findUnique({ where: { id: candidate.id } });
    if (!endpoint?.active || endpoint.ownerId !== candidate.ownerId || !endpoint.digestNextAt || endpoint.digestNextAt > now) return { outcome: 'notClaimed' };
    if (!endpoint.eventTypes.includes(DIGEST_EVENT_TYPE) || endpoint.digestHour === null || endpoint.digestTimezone === null) {
      await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { digestNextAt: null } });
      return { outcome: 'notClaimed' };
    }
    if (!mayManage) return { outcome: 'disabled', disabled: await disableEndpointTx(tx, endpoint, 'owner_lost_access', now) };
    const slot = digestSlot(endpoint.digestHour, endpoint.digestTimezone, now);
    if (slot.slotAt < endpoint.digestNextAt) {
      // A due time off the hour's grid (never written by this code): move on to the next slot.
      await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { digestNextAt: slot.nextAt } });
      return { outcome: 'notClaimed' };
    }
    const content = await digestContent(tx, endpoint, slot);
    const deliveryId = randomUUID();
    const payload = renderDeliveryBody(formatOf(endpoint.format), {
      deliveryId, type: DIGEST_EVENT_TYPE, createdAt: slot.slotAt, projectId: endpoint.projectId, workspaceId: content.workspaceId, data: content.data,
    }, () => content.context);
    const inserted = await tx.webhookDelivery.createMany({
      data: [{ id: deliveryId, endpointId: endpoint.id, eventId: digestEventId(slot.localDate), eventType: DIGEST_EVENT_TYPE, payload, status: 'pending', nextAttemptAt: new Date() }],
      skipDuplicates: true,
    });
    await tx.webhookEndpoint.update({ where: { id: endpoint.id }, data: { digestNextAt: slot.nextAt } });
    return { outcome: inserted.count === 1 ? 'recorded' : 'duplicate' };
  }, PRISMA_TX_OPTIONS);
  if (result.disabled) await notifyEndpointDisabled(result.disabled);
  return result.outcome;
}

/**
 * Record the digests that are due (oldest first, at most `limit`). Runs at
 * the start of every webhook cycle, so a digest is recorded within a cycle
 * of its hour (5 s with the interval runner, a minute with pg-boss) and sent
 * by the same pass. Safe on several workers at once (see the header).
 */
export async function runDueDigests(options: { now?: Date; limit?: number } = {}): Promise<DigestSweepResult> {
  const now = options.now ?? new Date();
  const due = await prisma.webhookEndpoint.findMany({
    where: { active: true, eventTypes: { has: DIGEST_EVENT_TYPE }, digestNextAt: { lte: now } },
    orderBy: [{ digestNextAt: 'asc' }, { id: 'asc' }],
    take: Math.max(1, Math.trunc(options.limit ?? DIGEST_SWEEP_LIMIT)),
    select: { id: true, scope: true, projectId: true, workspaceId: true, ownerId: true },
  });
  const result: DigestSweepResult = { examined: due.length, recorded: 0, duplicate: 0, notClaimed: 0, disabled: 0, failed: 0 };
  for (const candidate of due) {
    try {
      result[await recordDigest(candidate, now)] += 1;
    } catch (err) {
      result.failed += 1;
      logger.error({ err, webhookId: candidate.id }, '[webhooks] recording a daily digest failed; retrying on the next cycle');
    }
  }
  if (result.examined > 0) logger.info(result, '[webhooks] daily digests');
  return result;
}
