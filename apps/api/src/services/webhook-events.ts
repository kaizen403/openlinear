import { randomUUID } from 'node:crypto';
import { type Prisma, prisma, type WebhookEndpoint } from '@openlinear/db';
import { transactionWithEvents } from '../events/outbox';
import { readPrunedThroughId } from '../events/stream';
import { logger } from '../logger';
import { disableEndpointTx, notifyEndpointDisabled, type DisabledEndpoint } from './webhook-delivery';
import { chatBody, formatOf, type MessageContext, type WebhookFormat } from './webhook-formats';
import { assertProjectAccess, isOwnershipError } from './ownership';
import { assertWorkspaceRole } from './workspaces';

/**
 * FE-14 webhooks: which events exist, what their payloads carry, and the
 * fan-out that turns committed domain events into deliveries. See
 * docs/reports/revamp-2026-10-26/webhooks.md §3–4.
 *
 * The fan-out reads the ordered event stream (`domain_events`, W04b) after
 * its own cursor (`webhook_fanout_cursor`). Stream ids become visible in
 * commit order, so "every id above the cursor" is complete. One transaction
 * per batch locks the cursor row (`FOR UPDATE SKIP LOCKED`: a second worker
 * skips instead of waiting), records the deliveries and advances the cursor,
 * so a batch is recorded once or not at all; the unique (endpoint, event)
 * key is the backstop. No request handler calls into webhooks: an endpoint
 * learns about a change only after it committed.
 *
 * Each endpoint gets the body in its format (`openlinear` JSON, or a Slack /
 * Discord message rendered by webhook-formats.ts), fixed when recorded.
 *
 * Tenancy: an endpoint receives an event only when the event's resource
 * binding (not its payload) names the endpoint's project (or a project of
 * its workspace), the event happened after the endpoint was created, and the
 * endpoint's owner still holds the rights needed to manage it. Payloads are
 * projections that carry no secrets, tokens, logs or free text beyond
 * titles.
 */

export const WEBHOOK_EVENT_TYPES = [
  'issue.created',
  'issue.updated',
  'issue.done',
  'issue.deleted',
  'run.succeeded',
  'run.failed',
  'run.cancelled',
  'plan.approved',
  'schedule.fired',
  // FE-14 follow-up: one summary a day at the endpoint's chosen hour (webhook-digest.ts), not from the stream.
  'digest.daily',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Sent only by "Send test ping"; never subscribed to. */
export const WEBHOOK_PING_TYPE = 'ping';

/** The exact body is stored and re-sent on every attempt; larger data is replaced. */
export const MAX_WEBHOOK_PAYLOAD_BYTES = 64 * 1024;
/** Issues per bulk-created event turned into `issue.created` deliveries. */
const MAX_BULK_ISSUES = 200;
const FANOUT_BATCH_SIZE = 500;
const FANOUT_MAX_BATCHES = 20;

const WEBHOOK_TYPE_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

export function isWebhookEventType(value: string): value is WebhookEventType {
  return WEBHOOK_TYPE_SET.has(value);
}

// ── Payloads ───────────────────────────────────────────────────────────────

/** What an issue looks like in a webhook: no description, outcome or logs. */
export interface WebhookIssue {
  id: string;
  identifier: string | null;
  number: number | null;
  title: string;
  status: string;
  priority: string;
  projectId: string | null;
  teamId: string | null;
  parentId: string | null;
  assigneeId: string | null;
  labels: Array<{ id: string; name: string }>;
  dueDate: string | null;
  prUrl: string | null;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

const issueSelect = {
  id: true, identifier: true, number: true, title: true, status: true, priority: true, projectId: true, teamId: true,
  parentId: true, assigneeId: true, dueDate: true, prUrl: true, archived: true, createdAt: true, updatedAt: true,
  labels: { select: { label: { select: { id: true, name: true } } } },
} satisfies Prisma.TaskSelect;

type IssueRow = Prisma.TaskGetPayload<{ select: typeof issueSelect }>;

function issueFromRow(row: IssueRow): WebhookIssue {
  return {
    id: row.id,
    identifier: row.identifier,
    number: row.number,
    title: row.title,
    status: row.status,
    priority: row.priority,
    projectId: row.projectId,
    teamId: row.teamId,
    parentId: row.parentId,
    assigneeId: row.assigneeId,
    labels: row.labels.map(({ label }) => ({ id: label.id, name: label.name })),
    dueDate: row.dueDate?.toISOString() ?? null,
    prUrl: row.prUrl,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** The issue projection of a task DTO carried by `task:created` / `task:updated`. */
export function issueFromDto(value: unknown): WebhookIssue | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const title = str(value.title);
  if (!id || title === null) return null;
  const labels = Array.isArray(value.labels)
    ? value.labels.flatMap((label) => (isRecord(label) && str(label.id) && str(label.name) !== null ? [{ id: String(label.id), name: String(label.name) }] : []))
    : [];
  return {
    id,
    identifier: str(value.identifier),
    number: typeof value.number === 'number' ? value.number : null,
    title,
    status: str(value.status) ?? 'todo',
    priority: str(value.priority) ?? 'medium',
    projectId: str(value.projectId),
    teamId: str(value.teamId),
    parentId: str(value.parentId),
    assigneeId: str(value.assigneeId),
    labels,
    dueDate: str(value.dueDate),
    prUrl: str(value.prUrl),
    archived: value.archived === true,
    createdAt: str(value.createdAt),
    updatedAt: str(value.updatedAt),
  };
}

export interface DeliveryEnvelope {
  deliveryId: string;
  type: string;
  createdAt: Date;
  projectId: string | null;
  workspaceId: string | null;
  data: Json;
}

/**
 * The JSON body of a delivery: `{ id, type, createdAt, projectId,
 * workspaceId, data }`, where `id` is the delivery id (stable across retries
 * and redeliveries). Bodies over the bound keep the envelope and say so.
 */
export function deliveryBody(envelope: DeliveryEnvelope): string {
  const head = {
    id: envelope.deliveryId,
    type: envelope.type,
    createdAt: envelope.createdAt.toISOString(),
    projectId: envelope.projectId,
    workspaceId: envelope.workspaceId,
  };
  const body = JSON.stringify({ ...head, data: envelope.data });
  if (Buffer.byteLength(body, 'utf8') <= MAX_WEBHOOK_PAYLOAD_BYTES) return body;
  const issue = isRecord(envelope.data.issue) ? { id: envelope.data.issue.id } : undefined;
  return JSON.stringify({ ...head, data: { truncated: true, ...(issue ? { issue } : {}) } });
}

/**
 * The body an endpoint receives for an envelope, in its format. `context`
 * (names for Slack / Discord text) is only read for those formats.
 */
export function renderDeliveryBody(format: WebhookFormat, envelope: DeliveryEnvelope, context: () => MessageContext): string {
  return format === 'openlinear' ? deliveryBody(envelope) : chatBody(format, envelope, context());
}

// ── Mapping stream events to webhook events ────────────────────────────────

/** A stream row with a project binding. */
export interface SourceEvent {
  id: bigint;
  type: string;
  occurredAt: Date;
  projectId: string;
  workspaceId: string | null;
  payload: unknown;
}

export interface WebhookEvent {
  /** Unique per source event and type: `evt_<stream id>:<type>[:<task id>]`. */
  eventId: string;
  type: WebhookEventType;
  occurredAt: Date;
  projectId: string;
  workspaceId: string | null;
  data: Json;
}

/** Stream event types that can produce webhook events. */
const SOURCE_TYPES: ReadonlySet<string> = new Set([
  'task:created', 'task:updated', 'task:deleted', 'tasks:bulk-created', 'activity:created', 'plan:approved',
]);

type Db = Prisma.TransactionClient | typeof prisma;

async function loadIssue(db: Db, taskId: string, projectId: string): Promise<WebhookIssue | null> {
  const row = await db.task.findUnique({ where: { id: taskId }, select: issueSelect });
  // The binding is authoritative: a payload naming another project's task is ignored.
  return row && row.projectId === projectId ? issueFromRow(row) : null;
}

/**
 * The webhook events one stream event stands for, limited to `wanted`
 * (the types some matching endpoint subscribes to), so nothing is loaded
 * for events nobody receives.
 */
export async function toWebhookEvents(db: Db, source: SourceEvent, wanted: ReadonlySet<WebhookEventType>): Promise<WebhookEvent[]> {
  const out: WebhookEvent[] = [];
  const emit = (type: WebhookEventType, data: Json, subKey?: string) => {
    out.push({
      eventId: `evt_${source.id}:${type}${subKey ? `:${subKey}` : ''}`,
      type, occurredAt: source.occurredAt, projectId: source.projectId, workspaceId: source.workspaceId, data,
    });
  };
  const payload = isRecord(source.payload) ? source.payload : {};

  switch (source.type) {
    case 'task:created':
    case 'task:updated': {
      const type = source.type === 'task:created' ? 'issue.created' : 'issue.updated';
      if (!wanted.has(type)) break;
      const issue = issueFromDto(payload);
      if (issue && issue.projectId === source.projectId) emit(type, { issue });
      break;
    }
    case 'task:deleted': {
      const id = str(payload.id);
      if (wanted.has('issue.deleted') && id) emit('issue.deleted', { issue: { id } });
      break;
    }
    case 'tasks:bulk-created': {
      if (!wanted.has('issue.created') || !Array.isArray(payload.taskIds)) break;
      const ids = payload.taskIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_BULK_ISSUES);
      const rows = await db.task.findMany({ where: { id: { in: ids }, projectId: source.projectId }, select: issueSelect });
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of ids) {
        const row = byId.get(id);
        if (row) emit('issue.created', { issue: issueFromRow(row) }, id);
      }
      break;
    }
    case 'activity:created': {
      const action = str(payload.action);
      const taskId = str(payload.taskId);
      const details = isRecord(payload.payload) ? payload.payload : {};
      if (!taskId) break;
      if (action === 'task_status_changed' && details.to === 'done' && wanted.has('issue.done')) {
        const issue = await loadIssue(db, taskId, source.projectId);
        if (issue) emit('issue.done', { issue, from: str(details.from), actorId: str(payload.userId), source: 'person' });
      } else if (action === 'agent_run_completed') {
        const status = str(details.status);
        const type = status === 'succeeded' ? 'run.succeeded' : status === 'failed' ? 'run.failed' : status === 'cancelled' ? 'run.cancelled' : null;
        const doneToo = status === 'succeeded' && wanted.has('issue.done');
        if (!(type && wanted.has(type)) && !doneToo) break;
        const issue = await loadIssue(db, taskId, source.projectId);
        if (!issue) break;
        const runId = str(details.agentRunId);
        const run = runId ? await db.agentRun.findUnique({
          where: { id: runId },
          select: { id: true, taskId: true, agent: true, model: true, status: true, startedAt: true, endedAt: true, prUrl: true },
        }) : null;
        const runView = run && run.taskId === taskId
          ? { id: run.id, agent: run.agent, model: run.model, status: run.status, startedAt: run.startedAt.toISOString(), endedAt: run.endedAt?.toISOString() ?? null, prUrl: run.prUrl }
          : { id: runId, status };
        if (type && wanted.has(type)) emit(type, { run: runView, issue });
        // A run succeeds only after its done projection: the issue is done too.
        if (doneToo) emit('issue.done', { issue, from: null, actorId: null, source: 'agent', runId });
      } else if (action === 'task_created' && details.source === 'schedule' && wanted.has('schedule.fired')) {
        const issue = await loadIssue(db, taskId, source.projectId);
        const scheduleId = str(details.scheduleId);
        if (!issue || !scheduleId) break;
        const schedule = await db.issueSchedule.findUnique({ where: { id: scheduleId }, select: { id: true, title: true, cadence: true, projectId: true } });
        emit('schedule.fired', {
          schedule: schedule && schedule.projectId === source.projectId ? { id: schedule.id, title: schedule.title, cadence: schedule.cadence } : { id: scheduleId },
          issue,
        });
      }
      break;
    }
    case 'plan:approved': {
      const planId = str(payload.planId);
      if (!wanted.has('plan.approved') || !planId) break;
      const plan = await db.plan.findUnique({ where: { id: planId }, select: { id: true, title: true, projectId: true } });
      if (plan && plan.projectId === source.projectId) {
        emit('plan.approved', { plan: { id: plan.id, title: plan.title, revision: typeof payload.revision === 'number' ? payload.revision : null } });
      }
      break;
    }
    default:
      break;
  }
  return out;
}

// ── Fan-out ────────────────────────────────────────────────────────────────

export interface FanOutResult {
  /** Stream events read past the cursor. */
  scanned: number;
  /** Deliveries recorded (duplicates excluded). */
  recorded: number;
  /** Another worker holds the cursor. */
  busy: boolean;
}

type CandidateEndpoint = Pick<WebhookEndpoint, 'id' | 'scope' | 'projectId' | 'workspaceId' | 'eventTypes' | 'createdAt' | 'ownerId' | 'url' | 'format'>;

function endpointMatches(endpoint: CandidateEndpoint, source: Pick<SourceEvent, 'projectId' | 'workspaceId' | 'occurredAt'>): boolean {
  if (source.occurredAt < endpoint.createdAt) return false;
  return endpoint.scope === 'project'
    ? endpoint.projectId === source.projectId
    : endpoint.workspaceId !== null && endpoint.workspaceId === source.workspaceId;
}

/** The owner may still manage the endpoint (fan-out, digests). */
export async function ownerMayManage(endpoint: Pick<WebhookEndpoint, 'scope' | 'projectId' | 'workspaceId' | 'ownerId'>): Promise<boolean> {
  try {
    if (endpoint.scope === 'project' && endpoint.projectId) {
      const access = await assertProjectAccess(endpoint.projectId, endpoint.ownerId, 'full');
      if (access.workspaceId) await assertWorkspaceRole(access.workspaceId, endpoint.ownerId, ['owner', 'admin']);
      return true;
    }
    if (endpoint.scope === 'workspace' && endpoint.workspaceId) {
      await assertWorkspaceRole(endpoint.workspaceId, endpoint.ownerId, ['owner', 'admin']);
      return true;
    }
    return false;
  } catch (err) {
    if (isOwnershipError(err)) return false;
    throw err;
  }
}

/** A workspace endpoint never carries events of a project its owner is denied. */
async function ownerMayView(ownerId: string, projectId: string): Promise<boolean> {
  try {
    await assertProjectAccess(projectId, ownerId, 'view');
    return true;
  } catch (err) {
    if (isOwnershipError(err)) return false;
    throw err;
  }
}

interface BatchOutcome {
  kind: 'busy' | 'idle' | 'advanced';
  scanned: number;
  recorded: number;
  disabled: DisabledEndpoint[];
}

async function fanOutBatch(batchSize: number): Promise<BatchOutcome> {
  return transactionWithEvents(async (tx): Promise<BatchOutcome> => {
    const locked = await tx.$queryRaw<Array<{ last_event_id: bigint }>>`
      SELECT last_event_id FROM webhook_fanout_cursor WHERE id = 1 FOR UPDATE SKIP LOCKED`;
    const cursorRow = locked[0];
    if (!cursorRow) {
      // Missing (never expected after the migration) or held by another worker.
      await tx.$executeRaw`
        INSERT INTO webhook_fanout_cursor (id, last_event_id, updated_at)
        SELECT 1, COALESCE(MAX(id), 0), (now() AT TIME ZONE 'UTC') FROM domain_events
        ON CONFLICT (id) DO NOTHING`;
      return { kind: 'busy', scanned: 0, recorded: 0, disabled: [] };
    }
    const cursor = cursorRow.last_event_id;
    const rows = await tx.domainEvent.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: { id: true, type: true, occurredAt: true, projectId: true, workspaceId: true, resourceType: true },
    });
    const last = rows.at(-1);
    if (!last) return { kind: 'idle', scanned: 0, recorded: 0, disabled: [] };

    const candidates = rows.filter((row): row is typeof row & { projectId: string } =>
      SOURCE_TYPES.has(row.type) && row.projectId !== null && (row.resourceType === 'project' || row.resourceType === 'team'));
    let recorded = 0;
    const disabled: DisabledEndpoint[] = [];
    if (candidates.length > 0) {
      const projectIds = [...new Set(candidates.map((row) => row.projectId))];
      const workspaceIds = [...new Set(candidates.flatMap((row) => (row.workspaceId ? [row.workspaceId] : [])))];
      const endpoints = await tx.webhookEndpoint.findMany({
        where: {
          active: true,
          OR: [
            { scope: 'project', projectId: { in: projectIds } },
            ...(workspaceIds.length > 0 ? [{ scope: 'workspace', workspaceId: { in: workspaceIds } }] : []),
          ],
        },
        select: { id: true, scope: true, projectId: true, workspaceId: true, eventTypes: true, createdAt: true, ownerId: true, url: true, format: true },
      });
      if (endpoints.length > 0) {
        recorded = await recordDeliveries(tx, candidates, endpoints, disabled);
      }
    }
    await tx.webhookFanoutCursor.update({ where: { id: 1 }, data: { lastEventId: last.id, updatedAt: new Date() } });
    return { kind: 'advanced', scanned: rows.length, recorded, disabled };
  }, { timeout: 30_000, maxWait: 5_000 });
}

async function recordDeliveries(
  tx: Prisma.TransactionClient,
  candidates: Array<{ id: bigint; type: string; occurredAt: Date; projectId: string; workspaceId: string | null }>,
  endpoints: CandidateEndpoint[],
  disabled: DisabledEndpoint[],
): Promise<number> {
  const payloads = new Map((await tx.domainEvent.findMany({
    where: { id: { in: candidates.map((row) => row.id) } },
    select: { id: true, payload: true },
  })).map((row) => [row.id, row.payload]));
  const managed = new Map<string, boolean>();
  const visible = new Map<string, boolean>();
  const rows: Prisma.WebhookDeliveryCreateManyInput[] = [];
  const now = new Date();
  // Project names for Slack / Discord text, loaded once per project and only when such an endpoint receives something.
  const contexts = new Map<string, MessageContext>();
  const loadContext = async (projectId: string) => {
    if (contexts.has(projectId)) return;
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { name: true } });
    contexts.set(projectId, { projectName: project?.name ?? null, workspaceName: null });
  };

  for (const candidate of candidates) {
    const source: SourceEvent = { ...candidate, payload: payloads.get(candidate.id) ?? null };
    const receivers: CandidateEndpoint[] = [];
    for (const endpoint of endpoints) {
      if (!endpointMatches(endpoint, source) || disabled.some((entry) => entry.id === endpoint.id)) continue;
      let mayManage = managed.get(endpoint.id);
      if (mayManage === undefined) {
        mayManage = await ownerMayManage(endpoint);
        managed.set(endpoint.id, mayManage);
        if (!mayManage) {
          disabled.push(await disableEndpointTx(tx, endpoint, 'owner_lost_access', now));
          continue;
        }
      }
      if (!mayManage) continue;
      if (endpoint.scope === 'workspace') {
        const key = `${endpoint.ownerId}:${source.projectId}`;
        let mayView = visible.get(key);
        if (mayView === undefined) {
          mayView = await ownerMayView(endpoint.ownerId, source.projectId);
          visible.set(key, mayView);
        }
        if (!mayView) continue;
      }
      receivers.push(endpoint);
    }
    if (receivers.length === 0) continue;
    const wanted = new Set(receivers.flatMap((endpoint) => endpoint.eventTypes.filter(isWebhookEventType)));
    const events = await toWebhookEvents(tx, source, wanted);
    if (events.length > 0 && receivers.some((endpoint) => formatOf(endpoint.format) !== 'openlinear')) await loadContext(source.projectId);
    const context = () => contexts.get(source.projectId) ?? { projectName: null, workspaceName: null };
    for (const event of events) {
      for (const endpoint of receivers) {
        if (!endpoint.eventTypes.includes(event.type)) continue;
        const deliveryId = randomUUID();
        rows.push({
          id: deliveryId,
          endpointId: endpoint.id,
          eventId: event.eventId,
          eventType: event.type,
          payload: renderDeliveryBody(formatOf(endpoint.format), { deliveryId, type: event.type, createdAt: event.occurredAt, projectId: event.projectId, workspaceId: event.workspaceId, data: event.data }, context),
          status: 'pending',
          nextAttemptAt: now,
        });
      }
    }
  }
  if (rows.length === 0) return 0;
  const inserted = await tx.webhookDelivery.createMany({ data: rows, skipDuplicates: true });
  return inserted.count;
}

/**
 * Turn committed stream events into deliveries, batch by batch, until the
 * stream is caught up (or `maxBatches` were handled). Safe on several
 * workers at once: whoever holds the cursor row works, the others return
 * `busy`.
 */
export async function fanOutWebhookEvents(options: { batchSize?: number; maxBatches?: number } = {}): Promise<FanOutResult> {
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? FANOUT_BATCH_SIZE));
  const maxBatches = Math.max(1, Math.trunc(options.maxBatches ?? FANOUT_MAX_BATCHES));
  const result: FanOutResult = { scanned: 0, recorded: 0, busy: false };
  let size = batchSize;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    let outcome: BatchOutcome;
    try {
      outcome = await fanOutBatch(size);
    } catch (err) {
      // One bad event must not stall every tenant's webhooks: retry smaller,
      // and skip a single event that keeps failing while the database is fine.
      if (size > 1) {
        size = Math.max(1, Math.floor(size / 2));
        logger.warn({ err, batchSize: size }, '[webhooks] fan-out batch failed; retrying with a smaller batch');
        continue;
      }
      const healthy = await prisma.$queryRaw`SELECT 1`.then(() => true, () => false);
      if (!healthy) throw err;
      const skipped = await skipFanOutEvent();
      logger.error({ err, eventId: skipped?.toString() ?? null }, '[webhooks] skipped a stream event that keeps failing to fan out');
      if (skipped === null) break;
      continue;
    }
    size = batchSize;
    for (const endpoint of outcome.disabled) await notifyEndpointDisabled(endpoint);
    result.scanned += outcome.scanned;
    result.recorded += outcome.recorded;
    if (outcome.kind === 'busy') {
      result.busy = true;
      break;
    }
    if (outcome.kind === 'idle' || outcome.scanned < batchSize) break;
  }
  return result;
}

/** Moves the fan-out cursor past the next event (it is not delivered to any endpoint). Null when there is none or another worker holds the cursor. */
async function skipFanOutEvent(): Promise<bigint | null> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<Array<{ last_event_id: bigint }>>`
      SELECT last_event_id FROM webhook_fanout_cursor WHERE id = 1 FOR UPDATE SKIP LOCKED`;
    const cursor = locked[0]?.last_event_id;
    if (cursor === undefined) return null;
    const next = await tx.domainEvent.findFirst({ where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, select: { id: true } });
    if (!next) return null;
    await tx.webhookFanoutCursor.update({ where: { id: 1 }, data: { lastEventId: next.id, updatedAt: new Date() } });
    return next.id;
  });
}

/** Operational check: retention removed stream events the fan-out never read. */
export async function webhookFanoutLag(): Promise<{ cursor: bigint; prunedThroughId: bigint; missedEvents: boolean }> {
  const row = await prisma.webhookFanoutCursor.findUnique({ where: { id: 1 } });
  const cursor = row?.lastEventId ?? 0n;
  const prunedThroughId = await readPrunedThroughId();
  const missedEvents = cursor < prunedThroughId;
  if (missedEvents) logger.warn({ cursor: cursor.toString(), prunedThroughId: prunedThroughId.toString() }, '[webhooks] fan-out fell behind stream retention; some events were never delivered');
  return { cursor, prunedThroughId, missedEvents };
}
