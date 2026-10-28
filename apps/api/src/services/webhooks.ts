import { randomBytes, randomUUID } from 'node:crypto';
import { hasRequiredScopes } from '@openlinear/api-core';
import { decryptToken, encryptToken, prisma, type Prisma, type WebhookDelivery, type WebhookEndpoint } from '@openlinear/db';
import { HttpError, ValidationError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { PRISMA_TX_OPTIONS } from '../lib/constants';
import { logger } from '../logger';
import type { CreateWebhookBody, ListWebhookDeliveriesQuery, UpdateWebhookBody } from '../schemas/webhooks';
import type { IdempotentCommand } from './idempotency';
import { assertProjectAccess, isOwnershipError } from './ownership';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_SECRET_GRACE_MS,
  appendWebhookEvent,
  attemptDeliveryNow,
  disableEndpointTx,
  runWebhookDeliveries,
} from './webhook-delivery';
import { digestSettings, resolveDigestTimeZone, runDueDigests } from './webhook-digest';
import { WEBHOOK_EVENT_TYPES, WEBHOOK_PING_TYPE, fanOutWebhookEvents, renderDeliveryBody, webhookFanoutLag } from './webhook-events';
import { WEBHOOK_FORMATS, assertFormatFitsUrl, formatOf, type MessageContext, type WebhookFormat } from './webhook-formats';
import { displayWebhookUrl, normalizeWebhookUrl } from './webhook-network';
import { assertWorkspaceRole } from './workspaces';

/**
 * FE-14 / W20: outbound webhooks — endpoint management, delivery history,
 * test pings and redelivery. See docs/reports/revamp-2026-10-26/webhooks.md.
 *
 * An endpoint belongs to a project (managed by people with full project
 * access who are workspace owners/admins — the rule of project verification
 * settings) or to a workspace (its owners/admins). Everyone who can see the
 * project (or is a workspace member) reads the list and the delivery
 * history, with the URL reduced to its origin: webhook paths often carry
 * tokens. Creating an endpoint and rotating its secret return the secret
 * once; the routes require an interactive session for them.
 *
 * Whoever creates or last changes an endpoint becomes its owner: the
 * fan-out checks the owner's rights before each delivery and turns the
 * endpoint off when they are gone (webhook-events.ts).
 *
 * Each endpoint has a body `format` (signed OpenLinear JSON, or a Slack /
 * Discord message; webhook-formats.ts — a format only accepts its
 * receiver's URLs) and, when subscribed to `digest.daily`, a local hour and
 * IANA zone for the daily digest (webhook-digest.ts).
 */

/** Endpoints per project, and per workspace. */
export const MAX_WEBHOOKS_PER_SCOPE = 10;
/** Finished deliveries older than this are pruned. */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
const SECRET_PREFIX = 'whsec_';
const DEFAULT_DELIVERY_PAGE = 25;

export type WebhookScope = { kind: 'project'; projectId: string } | { kind: 'workspace'; workspaceId: string };

/** `whsec_` + 32 random bytes (base64url). Used as given as the HMAC key. */
export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export interface WebhookView {
  id: string;
  scope: 'project' | 'workspace';
  projectId: string | null;
  workspaceId: string | null;
  /** The full URL, for people who may manage the endpoint; null for everyone else. */
  url: string | null;
  /** Origin plus "/…" when the URL has a path or query. */
  urlDisplay: string;
  description: string | null;
  eventTypes: string[];
  /** openlinear (signed JSON) | slack | discord. */
  format: WebhookFormat;
  /** `digest.daily`: local hour (0-23) and IANA zone of the daily digest. */
  digestHour: number | null;
  digestTimezone: string | null;
  /** When the next digest is due (null while off or not subscribed). */
  digestNextAt: string | null;
  /** "whsec_AbCd": enough to tell secrets apart, never enough to sign. */
  secretPrefix: string;
  /** Until when the previous secret also signs (after a rotation). */
  previousSecretExpiresAt: string | null;
  active: boolean;
  disabledAt: string | null;
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  ownerId: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** `revealUrl`: the full URL (a Slack or Discord URL is itself a credential); otherwise only `urlDisplay`. */
export function webhookView(row: WebhookEndpoint, revealUrl: boolean, now = new Date()): WebhookView {
  return {
    id: row.id,
    scope: row.scope === 'workspace' ? 'workspace' : 'project',
    projectId: row.projectId,
    workspaceId: row.workspaceId,
    url: revealUrl ? row.url : null,
    urlDisplay: displayWebhookUrl(row.url),
    description: row.description,
    eventTypes: row.eventTypes,
    format: formatOf(row.format),
    digestHour: row.digestHour,
    digestTimezone: row.digestTimezone,
    digestNextAt: row.digestNextAt?.toISOString() ?? null,
    secretPrefix: row.secretPrefix,
    previousSecretExpiresAt: row.previousSecretExpiresAt && row.previousSecretExpiresAt > now ? row.previousSecretExpiresAt.toISOString() : null,
    active: row.active,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    disabledReason: row.disabledReason,
    consecutiveFailures: row.consecutiveFailures,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
    ownerId: row.ownerId,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface DeliverySummary {
  id: string;
  eventId: string;
  eventType: string;
  status: 'pending' | 'succeeded' | 'failed' | 'abandoned';
  /** Attempts since it was created or last redelivered. */
  attempts: number;
  maxAttempts: number;
  /** When the next attempt is due (pending only). */
  nextAttemptAt: string | null;
  /** A worker is sending it right now. */
  inFlight: boolean;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  deliveredAt: string | null;
  redeliveries: number;
  createdAt: string;
}

export interface DeliveryDetail extends DeliverySummary {
  /** The exact JSON body sent. */
  payload: string;
  lastResponseExcerpt: string | null;
}

function deliveryStatus(value: string): DeliverySummary['status'] {
  return value === 'succeeded' || value === 'failed' || value === 'abandoned' ? value : 'pending';
}

function deliverySummary(row: WebhookDelivery, now = new Date()): DeliverySummary {
  return {
    id: row.id,
    eventId: row.eventId,
    eventType: row.eventType,
    status: deliveryStatus(row.status),
    attempts: row.attempts,
    maxAttempts: row.eventType === WEBHOOK_PING_TYPE ? 1 : WEBHOOK_MAX_ATTEMPTS,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
    inFlight: row.leaseExpiresAt !== null && row.leaseExpiresAt > now,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastDurationMs: row.lastDurationMs,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    redeliveries: row.redeliveries,
    createdAt: row.createdAt.toISOString(),
  };
}

function deliveryDetail(row: WebhookDelivery): DeliveryDetail {
  return { ...deliverySummary(row), payload: row.payload, lastResponseExcerpt: row.lastResponseExcerpt };
}

// ── Authorization ──────────────────────────────────────────────────────────

function scopeOf(row: Pick<WebhookEndpoint, 'scope' | 'projectId' | 'workspaceId'>): WebhookScope {
  if (row.scope === 'workspace' && row.workspaceId) return { kind: 'workspace', workspaceId: row.workspaceId };
  if (row.projectId) return { kind: 'project', projectId: row.projectId };
  throw new HttpError(500, 'WEBHOOK_CORRUPT', 'A stored webhook has no scope');
}

/** Manage rights; returns the workspace the endpoint belongs to (idempotency scope, audit). */
async function assertManage(scope: WebhookScope, userId: string): Promise<{ workspaceId: string | null }> {
  if (scope.kind === 'workspace') {
    await assertWorkspaceRole(scope.workspaceId, userId, ['owner', 'admin']);
    return { workspaceId: scope.workspaceId };
  }
  const access = await assertProjectAccess(scope.projectId, userId, 'full');
  if (access.workspaceId) await assertWorkspaceRole(access.workspaceId, userId, ['owner', 'admin']);
  return { workspaceId: access.workspaceId };
}

async function assertRead(scope: WebhookScope, userId: string): Promise<void> {
  if (scope.kind === 'workspace') await assertWorkspaceRole(scope.workspaceId, userId, ['owner', 'admin', 'member', 'viewer']);
  else await assertProjectAccess(scope.projectId, userId, 'view');
}

/**
 * A workspace endpoint's deliveries and digests carry every project of the
 * workspace its owner may see: someone explicitly denied any project there
 * may not read, redeliver or redirect them.
 */
async function assertSeesWholeWorkspace(scope: WebhookScope, userId: string): Promise<void> {
  if (scope.kind !== 'workspace') return;
  const denied = await prisma.projectAccess.count({ where: { userId, permission: 'deny', project: { workspaceId: scope.workspaceId } } });
  if (denied > 0) {
    throw new HttpError(403, 'WEBHOOK_WORKSPACE_RESTRICTED', "This workspace webhook carries projects you can't see; ask a workspace owner who can see them all");
  }
}

/**
 * A personal access token's scopes; `null` for a person's session. Route
 * declarations check the project family (`projects:read` / `projects:write`)
 * for every `/api/webhooks/:id` operation; a workspace endpoint is workspace
 * configuration, so a PAT also needs the workspace family there
 * (`workspaces:read` to read, `admin` to act).
 */
export type PatScopes = readonly string[] | null;

function assertPatFamily(scope: WebhookScope, patScopes: PatScopes, access: 'read' | 'write'): void {
  if (patScopes === null || scope.kind !== 'workspace') return;
  const required = access === 'read' ? ['workspaces:read'] : ['admin'];
  if (!hasRequiredScopes(patScopes, required)) {
    throw new HttpError(403, 'INSUFFICIENT_SCOPE', 'Personal access token lacks required scope', { requiredScopes: required });
  }
}

/**
 * The full URL goes to people who may manage the endpoint, in a session —
 * like the secret, it is never handed to a PAT, which could not have set it
 * either (creating and changing endpoints are session-only).
 */
async function mayRevealUrl(scope: WebhookScope, userId: string, patScopes: PatScopes): Promise<{ canManage: boolean; revealUrl: boolean }> {
  const canManage = await mayManage(scope, userId);
  return { canManage, revealUrl: canManage && patScopes === null };
}

async function mayManage(scope: WebhookScope, userId: string): Promise<boolean> {
  try {
    await assertManage(scope, userId);
    return true;
  } catch (err) {
    if (isOwnershipError(err)) return false;
    throw err;
  }
}

async function loadEndpoint(webhookId: string): Promise<WebhookEndpoint> {
  const row = await prisma.webhookEndpoint.findUnique({ where: { id: webhookId } });
  if (!row) throw new HttpError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
  return row;
}

function scopeWhere(scope: WebhookScope): Prisma.WebhookEndpointWhereInput {
  return scope.kind === 'project' ? { scope: 'project', projectId: scope.projectId } : { scope: 'workspace', workspaceId: scope.workspaceId };
}

/** Serializes the per-scope quota check. */
async function lockScope(tx: Prisma.TransactionClient, scope: WebhookScope): Promise<void> {
  const key = scope.kind === 'project' ? `project:${scope.projectId}` : `workspace:${scope.workspaceId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`openlinear-webhooks:${key}`}, 0))`;
}

async function audit(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string | null; actorId: string; action: string; endpoint: Pick<WebhookEndpoint, 'id' | 'scope' | 'projectId' | 'url'>; metadata?: Record<string, Prisma.InputJsonValue> },
): Promise<void> {
  if (!input.workspaceId) return;
  await tx.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: input.action,
      resourceType: 'webhook',
      resourceId: input.endpoint.id,
      // The origin only: the path may carry a receiver token.
      metadata: { scope: input.endpoint.scope, projectId: input.endpoint.projectId, origin: displayWebhookUrl(input.endpoint.url), ...input.metadata },
    },
  });
}

function notFoundIfGone(err: unknown): unknown {
  if (err && typeof err === 'object' && 'code' in err && err.code === 'P2025') return new HttpError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
  return err;
}

// ── Endpoints ──────────────────────────────────────────────────────────────

export async function listWebhooks(input: { scope: WebhookScope; userId: string; patScopes: PatScopes }) {
  await assertRead(input.scope, input.userId);
  const { canManage, revealUrl } = await mayRevealUrl(input.scope, input.userId, input.patScopes);
  const rows = await prisma.webhookEndpoint.findMany({
    where: scopeWhere(input.scope),
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: MAX_WEBHOOKS_PER_SCOPE,
  });
  return {
    items: rows.map((row) => webhookView(row, revealUrl)),
    canManage,
    eventTypes: WEBHOOK_EVENT_TYPES,
    formats: WEBHOOK_FORMATS,
    limits: { endpoints: MAX_WEBHOOKS_PER_SCOPE, maxAttempts: WEBHOOK_MAX_ATTEMPTS, retryDelaysMs: WEBHOOK_RETRY_DELAYS_MS },
  };
}

export async function getWebhook(input: { webhookId: string; userId: string; patScopes: PatScopes }) {
  const row = await loadEndpoint(input.webhookId);
  assertPatFamily(scopeOf(row), input.patScopes, 'read');
  await assertRead(scopeOf(row), input.userId);
  const { canManage, revealUrl } = await mayRevealUrl(scopeOf(row), input.userId, input.patScopes);
  return { ...webhookView(row, revealUrl), canManage };
}

/** What the create command stores for replay: the secret only as ciphertext. */
export type StoredWebhookCreate = WebhookView & { secret: null; sealedSecret: string };

/**
 * `POST …/webhooks` as an idempotent command (W04a keys). The stored
 * response carries the secret encrypted (`sealedSecret`); the route reveals
 * it on the way out (`revealSealedSecret`), so a retry with the same key gets
 * the same secret and the idempotency table never holds it in clear.
 */
interface PreparedCreate {
  url: string;
  format: WebhookFormat;
  digestTimezone: string | undefined;
}

export async function authorizeCreateWebhook(input: { scope: WebhookScope; userId: string; body: CreateWebhookBody }): Promise<IdempotentCommand<PreparedCreate, StoredWebhookCreate>> {
  const { workspaceId } = await assertManage(input.scope, input.userId);
  const { body, scope } = input;
  return {
    resolveWorkspaceId: async () => workspaceId,
    prepare: async () => {
      const url = normalizeWebhookUrl(body.url);
      const format = body.format ?? 'openlinear';
      assertFormatFitsUrl(format, url);
      return { url, format, digestTimezone: body.digestTimezone !== undefined ? resolveDigestTimeZone(body.digestTimezone) : undefined };
    },
    mutate: async (tx, { url, format, digestTimezone }) => {
      await lockScope(tx, scope);
      const count = await tx.webhookEndpoint.count({ where: scopeWhere(scope) });
      if (count >= MAX_WEBHOOKS_PER_SCOPE) {
        throw new HttpError(409, 'WEBHOOK_LIMIT_EXCEEDED', `A ${scope.kind} can have ${MAX_WEBHOOKS_PER_SCOPE} webhooks; delete one first`, { limit: MAX_WEBHOOKS_PER_SCOPE, scope: scope.kind });
      }
      const secret = generateWebhookSecret();
      const digest = digestSettings({ eventTypes: body.eventTypes, active: true, hour: body.digestHour, timezone: digestTimezone, now: new Date() });
      const row = await tx.webhookEndpoint.create({
        data: {
          scope: scope.kind,
          projectId: scope.kind === 'project' ? scope.projectId : null,
          workspaceId: scope.kind === 'workspace' ? scope.workspaceId : null,
          url,
          description: body.description || null,
          eventTypes: body.eventTypes,
          format,
          ...digest,
          secretEncrypted: encryptToken(secret),
          secretPrefix: secret.slice(0, SECRET_PREFIX.length + 4),
          ownerId: input.userId,
          createdById: input.userId,
        },
      });
      await appendWebhookEvent(tx, 'webhook:created', row, input.userId);
      await audit(tx, { workspaceId, actorId: input.userId, action: 'webhook.created', endpoint: row, metadata: { eventTypes: row.eventTypes, format: row.format } });
      return { status: 201, body: { ...webhookView(row, true), secret: null, sealedSecret: row.secretEncrypted } };
    },
  };
}

/**
 * Turn a stored create response into what the client receives: `secret` in
 * clear, `sealedSecret` removed. Other bodies (errors) pass through.
 */
export function revealSealedSecret(serialized: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return serialized;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !('sealedSecret' in parsed)) return serialized;
  const { sealedSecret, ...rest } = parsed;
  return JSON.stringify({ ...rest, secret: typeof sealedSecret === 'string' ? decryptToken(sealedSecret) : null });
}

/**
 * Change URL, description, events, format or digest time, or turn the
 * endpoint off/on. Turning it on resets the failure count (deliveries
 * abandoned while it was off stay abandoned; redeliver them one by one).
 * The URL and format must fit together (a Slack endpoint keeps a Slack URL).
 * Deliveries already recorded keep the body they were recorded with. The
 * caller becomes the owner.
 */
export async function updateWebhook(input: { webhookId: string; userId: string; body: UpdateWebhookBody }): Promise<WebhookView> {
  const existing = await loadEndpoint(input.webhookId);
  const { workspaceId } = await assertManage(scopeOf(existing), input.userId);
  await assertSeesWholeWorkspace(scopeOf(existing), input.userId);
  const { body } = input;
  const url = body.url !== undefined ? normalizeWebhookUrl(body.url) : undefined;
  if (url !== undefined || body.format !== undefined) assertFormatFitsUrl(body.format ?? formatOf(existing.format), url ?? existing.url);
  const digestTimezone = body.digestTimezone !== undefined ? resolveDigestTimeZone(body.digestTimezone) : undefined;
  const now = new Date();
  const row = await transactionWithEvents(async (tx) => {
    const turnOn = body.active === true && !existing.active;
    const turnOff = body.active === false && existing.active;
    // Read under the row lock: the digest sweep may have just moved `digestNextAt`.
    await tx.$queryRaw`SELECT id FROM webhook_endpoints WHERE id = ${existing.id} FOR UPDATE`;
    const current = await tx.webhookEndpoint.findUnique({ where: { id: existing.id } });
    if (!current) throw new HttpError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
    const digest = digestSettings({
      eventTypes: body.eventTypes ?? current.eventTypes,
      active: turnOff ? false : turnOn ? true : current.active,
      hour: body.digestHour,
      timezone: digestTimezone,
      previous: current,
      now,
    });
    const updated = await tx.webhookEndpoint.update({
      where: { id: existing.id },
      data: {
        ...(url !== undefined ? { url } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.eventTypes !== undefined ? { eventTypes: body.eventTypes } : {}),
        ...(body.format !== undefined ? { format: body.format } : {}),
        ...digest,
        ...(turnOn ? { active: true, disabledAt: null, disabledReason: null, consecutiveFailures: 0 } : {}),
        ownerId: input.userId,
      },
    }).catch((err: unknown) => {
      throw notFoundIfGone(err);
    });
    if (turnOff) await disableEndpointTx(tx, updated, 'manual', now);
    else await appendWebhookEvent(tx, 'webhook:updated', updated, input.userId);
    await audit(tx, {
      workspaceId, actorId: input.userId, action: 'webhook.updated', endpoint: updated,
      metadata: { changed: Object.keys(body), eventTypes: updated.eventTypes, format: updated.format, active: turnOff ? false : updated.active },
    });
    return tx.webhookEndpoint.findUniqueOrThrow({ where: { id: existing.id } });
  }, PRISMA_TX_OPTIONS);
  return webhookView(row, true);
}

/** Immediate; its delivery history goes with it. */
export async function deleteWebhook(input: { webhookId: string; userId: string; patScopes: PatScopes }): Promise<void> {
  const existing = await loadEndpoint(input.webhookId);
  assertPatFamily(scopeOf(existing), input.patScopes, 'write');
  const { workspaceId } = await assertManage(scopeOf(existing), input.userId);
  await transactionWithEvents(async (tx) => {
    const removed = await tx.webhookEndpoint.deleteMany({ where: { id: existing.id } });
    if (removed.count === 0) return;
    await appendWebhookEvent(tx, 'webhook:deleted', existing, input.userId);
    await audit(tx, { workspaceId, actorId: input.userId, action: 'webhook.deleted', endpoint: existing });
  }, PRISMA_TX_OPTIONS);
}

/**
 * New secret, shown once. The previous one keeps signing as a second `v1=`
 * for 24 hours so receivers can switch without dropping deliveries. The
 * caller becomes the owner.
 */
export async function rotateWebhookSecret(input: { webhookId: string; userId: string }): Promise<WebhookView & { secret: string }> {
  const existing = await loadEndpoint(input.webhookId);
  const { workspaceId } = await assertManage(scopeOf(existing), input.userId);
  const secret = generateWebhookSecret();
  const now = new Date();
  const row = await transactionWithEvents(async (tx) => {
    await tx.$queryRaw`SELECT id FROM webhook_endpoints WHERE id = ${existing.id} FOR UPDATE`;
    const current = await tx.webhookEndpoint.findUnique({ where: { id: existing.id } });
    if (!current) throw new HttpError(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found');
    // A second rotation inside the grace period would drop the secret receivers may still use.
    if (current.previousSecretEncrypted && current.previousSecretExpiresAt && current.previousSecretExpiresAt > now) {
      throw new HttpError(409, 'WEBHOOK_ROTATION_IN_PROGRESS', 'The previous secret still signs deliveries; rotate again after it expires', { previousSecretExpiresAt: current.previousSecretExpiresAt.toISOString() });
    }
    const updated = await tx.webhookEndpoint.update({
      where: { id: current.id },
      data: {
        secretEncrypted: encryptToken(secret),
        secretPrefix: secret.slice(0, SECRET_PREFIX.length + 4),
        previousSecretEncrypted: current.secretEncrypted,
        previousSecretExpiresAt: new Date(now.getTime() + WEBHOOK_SECRET_GRACE_MS),
        ownerId: input.userId,
      },
    });
    await appendWebhookEvent(tx, 'webhook:updated', updated, input.userId);
    await audit(tx, { workspaceId, actorId: input.userId, action: 'webhook.secret_rotated', endpoint: updated, metadata: { secretPrefix: updated.secretPrefix } });
    return updated;
  }, PRISMA_TX_OPTIONS);
  return { ...webhookView(row, true, now), secret };
}

// ── Deliveries ─────────────────────────────────────────────────────────────

const DELIVERY_CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f-]{36})$/;

function encodeDeliveryCursor(row: Pick<WebhookDelivery, 'createdAt' | 'id'>): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeDeliveryCursor(raw: string): { createdAt: Date; id: string } {
  const match = /^[A-Za-z0-9_-]+$/.test(raw) ? DELIVERY_CURSOR.exec(Buffer.from(raw, 'base64url').toString('utf8')) : null;
  const createdAt = match ? new Date(match[1] ?? '') : null;
  if (!match || !createdAt || Number.isNaN(createdAt.getTime())) throw new ValidationError('Invalid cursor', { field: 'cursor' });
  return { createdAt, id: match[2] ?? '' };
}

/** Newest first, keyset-paged on (createdAt, id). */
export async function listWebhookDeliveries(input: { webhookId: string; userId: string; patScopes: PatScopes; query: ListWebhookDeliveriesQuery }) {
  const endpoint = await loadEndpoint(input.webhookId);
  assertPatFamily(scopeOf(endpoint), input.patScopes, 'read');
  await assertRead(scopeOf(endpoint), input.userId);
  await assertSeesWholeWorkspace(scopeOf(endpoint), input.userId);
  const limit = input.query.limit ?? DEFAULT_DELIVERY_PAGE;
  const cursor = input.query.cursor ? decodeDeliveryCursor(input.query.cursor) : null;
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      endpointId: endpoint.id,
      ...(input.query.status ? { status: input.query.status } : {}),
      ...(cursor ? {
        AND: [
          { createdAt: { lte: cursor.createdAt } },
          { OR: [{ createdAt: { lt: cursor.createdAt } }, { id: { lt: cursor.id } }] },
        ],
      } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const now = new Date();
  return {
    items: page.map((row) => deliverySummary(row, now)),
    nextCursor: rows.length > limit && last ? encodeDeliveryCursor(last) : null,
  };
}

async function loadDelivery(endpointId: string, deliveryId: string): Promise<WebhookDelivery> {
  const row = await prisma.webhookDelivery.findFirst({ where: { id: deliveryId, endpointId } });
  if (!row) throw new HttpError(404, 'WEBHOOK_DELIVERY_NOT_FOUND', 'Delivery not found');
  return row;
}

/** One delivery with the exact body sent and the start of the last response. */
export async function getWebhookDelivery(input: { webhookId: string; deliveryId: string; userId: string; patScopes: PatScopes }): Promise<DeliveryDetail> {
  const endpoint = await loadEndpoint(input.webhookId);
  assertPatFamily(scopeOf(endpoint), input.patScopes, 'read');
  await assertRead(scopeOf(endpoint), input.userId);
  await assertSeesWholeWorkspace(scopeOf(endpoint), input.userId);
  return deliveryDetail(await loadDelivery(endpoint.id, input.deliveryId));
}

/** Names for Slack / Discord text of a delivery that is not tied to one event's project. */
async function endpointContext(endpoint: Pick<WebhookEndpoint, 'projectId' | 'workspaceId'>): Promise<MessageContext> {
  if (endpoint.projectId) {
    const project = await prisma.project.findUnique({ where: { id: endpoint.projectId }, select: { name: true } });
    return { projectName: project?.name ?? null, workspaceName: null };
  }
  const workspace = endpoint.workspaceId ? await prisma.workspace.findUnique({ where: { id: endpoint.workspaceId }, select: { name: true } }) : null;
  return { projectName: null, workspaceName: workspace?.name ?? null };
}

/**
 * "Send test ping": a `ping` delivery attempted right away (one attempt, no
 * retries, failure counter untouched), in the endpoint's format. Works while
 * the endpoint is off, so a fix can be checked before turning it back on.
 */
export async function pingWebhook(input: { webhookId: string; userId: string; patScopes: PatScopes }): Promise<DeliveryDetail> {
  const endpoint = await loadEndpoint(input.webhookId);
  assertPatFamily(scopeOf(endpoint), input.patScopes, 'write');
  const { workspaceId } = await assertManage(scopeOf(endpoint), input.userId);
  const deliveryId = randomUUID();
  const now = new Date();
  const format = formatOf(endpoint.format);
  const context = format === 'openlinear' ? null : await endpointContext(endpoint);
  await prisma.webhookDelivery.create({
    data: {
      id: deliveryId,
      endpointId: endpoint.id,
      eventId: `ping_${randomUUID()}`,
      eventType: WEBHOOK_PING_TYPE,
      payload: renderDeliveryBody(format, {
        deliveryId, type: WEBHOOK_PING_TYPE, createdAt: now, projectId: endpoint.projectId, workspaceId,
        data: { webhookId: endpoint.id, message: 'Test delivery from OpenLinear. Verify the signature, then answer 2xx.' },
      }, () => context ?? { projectName: null, workspaceName: null }),
      status: 'pending',
      nextAttemptAt: now,
    },
  });
  await attemptDeliveryNow(deliveryId);
  return deliveryDetail(await loadDelivery(endpoint.id, deliveryId));
}

/**
 * Send the same delivery again — same id and body, so the receiver can tell
 * it is not a new event — with a fresh retry schedule. Refused while it is in
 * flight, or while the endpoint is off (test pings excepted).
 */
export async function redeliverWebhookDelivery(input: { webhookId: string; deliveryId: string; userId: string; patScopes: PatScopes }): Promise<DeliveryDetail> {
  const endpoint = await loadEndpoint(input.webhookId);
  assertPatFamily(scopeOf(endpoint), input.patScopes, 'write');
  await assertManage(scopeOf(endpoint), input.userId);
  await assertSeesWholeWorkspace(scopeOf(endpoint), input.userId);
  const delivery = await loadDelivery(endpoint.id, input.deliveryId);
  if (!endpoint.active && delivery.eventType !== WEBHOOK_PING_TYPE) {
    throw new HttpError(409, 'WEBHOOK_DISABLED', 'Turn the webhook back on before redelivering', { webhookId: endpoint.id });
  }
  const now = new Date();
  const reset = await prisma.webhookDelivery.updateMany({
    where: { id: delivery.id, endpointId: endpoint.id, OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
    data: { status: 'pending', nextAttemptAt: now, attempts: 0, leaseToken: null, leaseExpiresAt: null, redeliveries: { increment: 1 } },
  });
  if (reset.count !== 1) {
    throw new HttpError(409, 'WEBHOOK_DELIVERY_IN_FLIGHT', 'This delivery is being sent right now; wait for the result', { deliveryId: delivery.id });
  }
  await attemptDeliveryNow(delivery.id);
  return deliveryDetail(await loadDelivery(endpoint.id, delivery.id));
}

// ── Jobs ───────────────────────────────────────────────────────────────────

let cycleRunning = false;

/**
 * One `webhook-deliver` pass: record deliveries for new events and for the
 * daily digests that are due, then send what is due. A pass still running
 * in this process (slow receivers) makes the next tick a no-op instead of
 * stacking claims; other processes are kept apart by the cursor lock, the
 * digest row locks and delivery leases.
 */
export async function runWebhookCycle() {
  if (cycleRunning) return null;
  cycleRunning = true;
  try {
    const fanOut = await fanOutWebhookEvents();
    const digests = await runDueDigests();
    const deliveries = await runWebhookDeliveries();
    if (fanOut.recorded > 0 || deliveries.claimed > 0) logger.info({ fanOut, digests: digests.recorded, deliveries }, '[webhooks] cycle');
    return { fanOut, digests, deliveries };
  } finally {
    cycleRunning = false;
  }
}

/** Finished deliveries older than the retention; pending ones are kept until they finish. */
export async function pruneWebhookDeliveries(retentionDays = WEBHOOK_DELIVERY_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 3_600_000);
  const removed = await prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: cutoff }, status: { not: 'pending' } } });
  await webhookFanoutLag();
  return removed.count;
}
