import { createHmac, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Prisma, decryptToken, prisma, type WebhookEndpoint } from '@openlinear/db';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, projectTarget, workspaceTarget } from '../events/targets';
import { logger } from '../logger';
import { createNotification } from '../routes/notifications';
import { assertConnectableHost, bareHostname, guardedLookup, usesLoopbackTestException } from './webhook-network';

/**
 * FE-14 webhooks: the delivery worker. See
 * docs/reports/revamp-2026-10-26/webhooks.md §4–6.
 *
 * A cycle claims due deliveries with a lease (`FOR UPDATE SKIP LOCKED` in the
 * claim, so concurrent workers never take the same row) and POSTs each one:
 *
 *   OpenLinear-Delivery:  <delivery id, the same on every retry>
 *   OpenLinear-Event:     <type>
 *   OpenLinear-Timestamp: <unix seconds of this attempt>
 *   OpenLinear-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *                         (plus `,v1=<…>` with the previous secret for 24 h after a rotation)
 *
 * 2xx is success. Anything else — another status, a redirect (never
 * followed), a timeout (10 s), a refused address — schedules the next attempt
 * (1 m, 5 m, 30 m, 2 h, 12 h; after the sixth attempt the delivery is
 * `failed`). Results are written fenced by the lease token, so a worker whose
 * lease expired cannot overwrite a newer attempt. A crash after the POST and
 * before the write re-sends the same delivery id: receivers dedupe on it.
 *
 * Twenty failed attempts in a row turn the endpoint off (its owner is
 * notified); pending deliveries of an endpoint that is off are abandoned.
 */

export const WEBHOOK_TIMEOUT_MS = 10_000;
/** Response bytes read before the connection is dropped. */
export const WEBHOOK_RESPONSE_READ_LIMIT = 4096;
export const WEBHOOK_EXCERPT_LIMIT = 1024;
/** Delay before attempt n + 1 after attempt n failed. */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;
export const WEBHOOK_DISABLE_AFTER_FAILURES = 20;
/** The previous secret keeps signing (second `v1=`) this long after a rotation. */
export const WEBHOOK_SECRET_GRACE_MS = 24 * 3_600_000;
const CLAIM_LIMIT = 50;
const CONCURRENCY = 8;
/**
 * Long enough for a whole claimed batch at full timeouts (plus a margin);
 * each delivery also renews it, fenced by its token, right before sending.
 */
const LEASE_MS = Math.ceil(CLAIM_LIMIT / CONCURRENCY) * WEBHOOK_TIMEOUT_MS + 60_000;
const USER_AGENT = 'OpenLinear-Webhooks/1';
const NOW_UTC = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

export const SIGNATURE_HEADER = 'OpenLinear-Signature';

// ── Signing ────────────────────────────────────────────────────────────────

/** Hex HMAC-SHA256 of `<timestamp>.<body>` keyed by the secret as shown to the user. */
export function webhookSignature(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** `v1=<current>[,v1=<previous>]`. */
export function signatureHeaderValue(secrets: readonly string[], timestamp: number, body: string): string {
  return secrets.map((secret) => `v1=${webhookSignature(secret, timestamp, body)}`).join(',');
}

/** The secrets that sign right now: the current one, plus the previous one during its grace period. */
export function signingSecrets(endpoint: Pick<WebhookEndpoint, 'secretEncrypted' | 'previousSecretEncrypted' | 'previousSecretExpiresAt'>, now = new Date()): string[] {
  const current = decryptToken(endpoint.secretEncrypted);
  if (!current) throw new Error('webhook endpoint has no signing secret');
  const previous = endpoint.previousSecretEncrypted && endpoint.previousSecretExpiresAt && endpoint.previousSecretExpiresAt > now
    ? decryptToken(endpoint.previousSecretEncrypted)
    : null;
  return previous ? [current, previous] : [current];
}

// ── HTTP ───────────────────────────────────────────────────────────────────

export interface PostResult {
  statusCode: number | null;
  /** Start of the response body (control characters removed). */
  excerpt: string | null;
  /** Why the attempt failed before or instead of a 2xx; null on success. */
  error: string | null;
  durationMs: number;
}

export function isSuccess(result: PostResult): boolean {
  return result.error === null && result.statusCode !== null && result.statusCode >= 200 && result.statusCode < 300;
}

function excerptOf(chunks: Buffer[]): string | null {
  if (chunks.length === 0) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  const text = Buffer.concat(chunks).toString('utf8').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, WEBHOOK_EXCERPT_LIMIT) : null;
}

function describeNetworkError(err: unknown): string {
  if (err && typeof err === 'object') {
    const code = 'code' in err && typeof err.code === 'string' ? err.code : null;
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'WEBHOOK_ADDRESS_FORBIDDEN') return message;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The host name did not resolve';
    if (code === 'ECONNREFUSED') return 'Connection refused';
    if (code === 'ECONNRESET') return 'Connection reset';
    if (code && /CERT|SSL|TLS/.test(code)) return `TLS error (${code})`;
    return code ? `${code}: ${message}`.slice(0, 300) : message.slice(0, 300);
  }
  return 'Request failed';
}

/**
 * POST `body` to `url` under the SSRF rules: refused addresses are never
 * contacted (resolution happens in `guardedLookup`, IP literals are checked
 * here), redirects are not followed, the whole exchange is bounded by
 * `WEBHOOK_TIMEOUT_MS` and at most `WEBHOOK_RESPONSE_READ_LIMIT` response
 * bytes are read. Never throws.
 */
export async function postWebhook(rawUrl: string, headers: Record<string, string>, body: string, options: { timeoutMs?: number } = {}): Promise<PostResult> {
  const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
  const started = Date.now();
  const done = (partial: Omit<PostResult, 'durationMs'>): PostResult => ({ ...partial, durationMs: Date.now() - started });
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== 'https:' && !usesLoopbackTestException(url)) {
      return done({ statusCode: null, excerpt: null, error: 'Only https:// URLs are delivered' });
    }
    assertConnectableHost(url);
  } catch (err) {
    return done({ statusCode: null, excerpt: null, error: describeNetworkError(err) });
  }
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<PostResult>((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    let read = 0;
    let statusCode: number | null = null;
    const finish = (result: Omit<PostResult, 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(done(result));
    };
    const request = transport.request({
      protocol: url.protocol,
      hostname: bareHostname(url),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      // A fresh connection per attempt: every connection goes through the guarded lookup.
      agent: false,
      lookup: guardedLookup,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
        'User-Agent': USER_AGENT,
      },
    }, (response) => {
      statusCode = response.statusCode ?? null;
      const complete = () => {
        const redirected = statusCode !== null && statusCode >= 300 && statusCode < 400;
        finish({
          statusCode,
          excerpt: excerptOf(chunks),
          error: redirected ? `Redirect to ${String(response.headers.location ?? 'another URL').slice(0, 200)} not followed` : null,
        });
      };
      response.on('data', (chunk: Buffer) => {
        if (read >= WEBHOOK_RESPONSE_READ_LIMIT) return;
        const take = chunk.subarray(0, WEBHOOK_RESPONSE_READ_LIMIT - read);
        chunks.push(take);
        read += take.length;
        if (read >= WEBHOOK_RESPONSE_READ_LIMIT) {
          // Enough for the excerpt: drop the rest instead of reading it.
          response.destroy();
          complete();
        }
      });
      response.on('end', complete);
      response.on('close', complete);
      response.on('error', complete);
    });
    const deadline = setTimeout(() => {
      const timeout = Object.assign(new Error('timeout'), { code: 'WEBHOOK_TIMEOUT' });
      // Also bounds a receiver that answered headers but trickles the body.
      if (statusCode !== null) finish({ statusCode, excerpt: excerptOf(chunks), error: `No complete response within ${timeoutMs / 1000} s` });
      request.destroy(timeout);
    }, timeoutMs);
    deadline.unref();
    request.on('error', (err) => {
      // A status line already arrived: the response decides (error after headers).
      if (statusCode !== null) finish({ statusCode, excerpt: excerptOf(chunks), error: null });
      else if ('code' in err && err.code === 'WEBHOOK_TIMEOUT') finish({ statusCode: null, excerpt: null, error: `No response within ${timeoutMs / 1000} s` });
      else finish({ statusCode: null, excerpt: null, error: describeNetworkError(err) });
    });
    request.end(body);
  });
}

// ── Endpoint state ─────────────────────────────────────────────────────────

export type DisabledReason = 'manual' | 'consecutive_failures' | 'owner_lost_access';

export interface DisabledEndpoint {
  id: string;
  url: string;
  ownerId: string;
  reason: DisabledReason;
}

type EndpointRef = Pick<WebhookEndpoint, 'id' | 'projectId' | 'workspaceId' | 'ownerId' | 'url'>;

/** `webhook:updated` to the endpoint's project (or workspace) audience: ids only. */
export async function appendWebhookEvent(
  tx: Prisma.TransactionClient,
  type: 'webhook:created' | 'webhook:updated' | 'webhook:deleted',
  endpoint: Pick<WebhookEndpoint, 'id' | 'projectId' | 'workspaceId'>,
  actorId: string | null,
): Promise<void> {
  const target = endpoint.projectId
    ? await projectTarget(tx, endpoint.projectId)
    : endpoint.workspaceId ? workspaceTarget(endpoint.workspaceId) : null;
  await appendToTarget(tx, target, type, { webhookId: endpoint.id, projectId: endpoint.projectId, workspaceId: endpoint.workspaceId }, actorId);
}

/**
 * Turn an endpoint off inside the caller's transaction and abandon its
 * pending deliveries that are not in flight (an in-flight one is abandoned
 * when its result is written).
 */
export async function disableEndpointTx(tx: Prisma.TransactionClient, endpoint: EndpointRef, reason: DisabledReason, now: Date): Promise<DisabledEndpoint> {
  await tx.webhookEndpoint.updateMany({ where: { id: endpoint.id, active: true }, data: { active: false, disabledAt: now, disabledReason: reason } });
  await tx.webhookDelivery.updateMany({
    where: { endpointId: endpoint.id, status: 'pending', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }] },
    data: { status: 'abandoned', nextAttemptAt: null, leaseToken: null, leaseExpiresAt: null, lastError: 'The endpoint was turned off' },
  });
  await appendWebhookEvent(tx, 'webhook:updated', endpoint, null);
  return { id: endpoint.id, url: endpoint.url, ownerId: endpoint.ownerId, reason };
}

/** After commit: tell the owner (existing in-app notifications; no task attached). */
export async function notifyEndpointDisabled(endpoint: DisabledEndpoint): Promise<void> {
  if (endpoint.reason === 'manual') return;
  let host = 'your endpoint';
  try {
    host = new URL(endpoint.url).host;
  } catch {
    // keep the generic wording
  }
  const body = endpoint.reason === 'consecutive_failures'
    ? `Webhook to ${host} was turned off after ${WEBHOOK_DISABLE_AFTER_FAILURES} failed deliveries in a row. Fix the receiver, then turn it back on in the project's webhook settings.`
    : `Webhook to ${host} was turned off: you can no longer manage webhooks there. An admin can turn it back on.`;
  await createNotification({ recipientUserId: endpoint.ownerId, actorUserId: null, type: 'status_change', body });
}

// ── Claim, attempt, record ─────────────────────────────────────────────────

interface ClaimedDelivery {
  id: string;
  endpointId: string;
  attempts: number;
  eventType: string;
  payload: string;
  leaseToken: string;
}

/**
 * Lease due deliveries of active endpoints (test pings also of endpoints
 * that are off). One statement: the `FOR UPDATE SKIP LOCKED` select keeps
 * concurrent claimers off the same rows while the lease is written; the
 * lease keeps them off until it expires.
 *
 * The select is a MATERIALIZED CTE, evaluated exactly once. As
 * `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` the planner may
 * pick a nested-loop semi join that re-runs the subquery for every row
 * (it does with the statistics of a small or new table); each re-run skips
 * the rows this statement already updated and returns the next ones, so a
 * pass claimed far more than `limit` rows, and leases could run out while
 * they waited in the queue (another worker would then send them again).
 */
async function claimDeliveries(input: { limit: number; deliveryId?: string }): Promise<ClaimedDelivery[]> {
  const leaseToken = randomUUID();
  // One named delivery (ping, redeliver) is attempted now; otherwise only due ones.
  const which = input.deliveryId
    ? Prisma.sql`AND wd.id = ${input.deliveryId}`
    : Prisma.sql`AND wd."nextAttemptAt" <= ${NOW_UTC}`;
  const rows = await prisma.$queryRaw<Array<Omit<ClaimedDelivery, 'leaseToken'>>>`
    WITH due AS MATERIALIZED (
      SELECT wd.id FROM webhook_deliveries AS wd
      JOIN webhook_endpoints AS e ON e.id = wd."endpointId"
      WHERE wd.status = 'pending'
        AND (wd."leaseExpiresAt" IS NULL OR wd."leaseExpiresAt" < ${NOW_UTC})
        AND (e.active OR wd."eventType" = 'ping')
        ${which}
      ORDER BY wd."nextAttemptAt", wd.id
      LIMIT ${input.limit}
      FOR UPDATE OF wd SKIP LOCKED
    )
    UPDATE webhook_deliveries AS d
    SET "leaseToken" = ${leaseToken},
        "leaseExpiresAt" = ${NOW_UTC} + make_interval(secs => ${LEASE_MS}::double precision / 1000),
        attempts = d.attempts + 1,
        "updatedAt" = ${NOW_UTC}
    FROM due
    WHERE d.id = due.id
    RETURNING d.id, d."endpointId", d.attempts, d."eventType", d.payload`;
  return rows.map((row) => ({ ...row, leaseToken }));
}

export type AttemptOutcome = 'succeeded' | 'retrying' | 'failed' | 'abandoned' | 'stale';

async function recordAttempt(claimed: ClaimedDelivery, result: PostResult, now: Date): Promise<{ outcome: AttemptOutcome; disabled: DisabledEndpoint | null }> {
  const ping = claimed.eventType === 'ping';
  const response = {
    lastAttemptAt: now,
    lastStatusCode: result.statusCode !== null && result.statusCode >= 100 && result.statusCode <= 599 ? result.statusCode : null,
    lastResponseExcerpt: result.excerpt,
    lastError: result.error ? result.error.slice(0, 500) : isSuccess(result) ? null : `HTTP ${result.statusCode ?? '?'}`,
    lastDurationMs: Math.min(result.durationMs, 2_147_483_647),
    leaseToken: null,
    leaseExpiresAt: null,
  };
  return transactionWithEvents(async (tx) => {
    const fence = { id: claimed.id, leaseToken: claimed.leaseToken };
    if (isSuccess(result)) {
      const written = await tx.webhookDelivery.updateMany({ where: fence, data: { ...response, status: 'succeeded', deliveredAt: now, nextAttemptAt: null } });
      if (written.count !== 1) return { outcome: 'stale' as const, disabled: null };
      if (!ping) await tx.webhookEndpoint.updateMany({ where: { id: claimed.endpointId }, data: { consecutiveFailures: 0, lastSuccessAt: now } });
      return { outcome: 'succeeded' as const, disabled: null };
    }
    const endpoint = await tx.webhookEndpoint.findUnique({ where: { id: claimed.endpointId }, select: { active: true } });
    const final = ping || claimed.attempts >= WEBHOOK_MAX_ATTEMPTS;
    const status = final ? 'failed' : endpoint?.active ? 'pending' : 'abandoned';
    const delay = WEBHOOK_RETRY_DELAYS_MS[Math.min(claimed.attempts, WEBHOOK_RETRY_DELAYS_MS.length) - 1] ?? WEBHOOK_RETRY_DELAYS_MS[0];
    const written = await tx.webhookDelivery.updateMany({
      where: fence,
      data: { ...response, status, nextAttemptAt: status === 'pending' ? new Date(now.getTime() + delay) : null },
    });
    if (written.count !== 1) return { outcome: 'stale' as const, disabled: null };
    const outcome: AttemptOutcome = status === 'pending' ? 'retrying' : status;
    if (ping || !endpoint) return { outcome, disabled: null };
    await tx.webhookEndpoint.updateMany({ where: { id: claimed.endpointId }, data: { consecutiveFailures: { increment: 1 }, lastFailureAt: now } });
    const counted = await tx.webhookEndpoint.findUnique({
      where: { id: claimed.endpointId },
      select: { id: true, projectId: true, workspaceId: true, ownerId: true, url: true, active: true, consecutiveFailures: true },
    });
    const disabled = counted?.active && counted.consecutiveFailures >= WEBHOOK_DISABLE_AFTER_FAILURES
      ? await disableEndpointTx(tx, counted, 'consecutive_failures', now)
      : null;
    return { outcome, disabled };
  }, { timeout: 15_000, maxWait: 5_000 });
}

/** Sign and POST one claimed delivery; never throws for network problems. */
async function send(claimed: ClaimedDelivery, endpoint: WebhookEndpoint | undefined, now: Date): Promise<PostResult> {
  if (!endpoint) return { statusCode: null, excerpt: null, error: 'The endpoint no longer exists', durationMs: 0 };
  const timestamp = Math.floor(now.getTime() / 1000);
  let signature: string;
  try {
    signature = signatureHeaderValue(signingSecrets(endpoint, now), timestamp, claimed.payload);
  } catch (err) {
    logger.error({ err, webhookId: endpoint.id }, '[webhooks] signing secret unavailable');
    return { statusCode: null, excerpt: null, error: 'The signing secret could not be read', durationMs: 0 };
  }
  return postWebhook(endpoint.url, {
    'OpenLinear-Delivery': claimed.id,
    'OpenLinear-Event': claimed.eventType,
    'OpenLinear-Timestamp': String(timestamp),
    [SIGNATURE_HEADER]: signature,
  }, claimed.payload);
}

/**
 * Right before the POST: still ours (lease token) and the endpoint still on
 * (pings excepted)? Renews the lease when so. Otherwise nothing is sent: a
 * lost lease belongs to another worker; an endpoint turned off meanwhile gets
 * its lease and the attempt count back.
 */
async function keepLease(claimed: ClaimedDelivery): Promise<boolean> {
  const renewed = await prisma.$executeRaw`
    UPDATE webhook_deliveries AS d
    SET "leaseExpiresAt" = ${NOW_UTC} + make_interval(secs => ${LEASE_MS}::double precision / 1000)
    FROM webhook_endpoints AS e
    WHERE d.id = ${claimed.id} AND d."leaseToken" = ${claimed.leaseToken} AND d.status = 'pending'
      AND e.id = d."endpointId" AND (e.active OR d."eventType" = 'ping')`;
  if (renewed === 1) return true;
  await prisma.$executeRaw`
    UPDATE webhook_deliveries
    SET "leaseToken" = NULL, "leaseExpiresAt" = NULL, attempts = GREATEST(attempts - 1, 0), "updatedAt" = ${NOW_UTC}
    WHERE id = ${claimed.id} AND "leaseToken" = ${claimed.leaseToken} AND status = 'pending'`;
  return false;
}

async function attempt(claimed: ClaimedDelivery, endpoints: Map<string, WebhookEndpoint>): Promise<AttemptOutcome> {
  if (!(await keepLease(claimed))) return 'stale';
  const result = await send(claimed, endpoints.get(claimed.endpointId), new Date());
  const recorded = await recordAttempt(claimed, result, new Date());
  if (recorded.disabled) await notifyEndpointDisabled(recorded.disabled);
  return recorded.outcome;
}

async function attemptAll(claimed: ClaimedDelivery[]): Promise<Record<AttemptOutcome, number>> {
  const counts: Record<AttemptOutcome, number> = { succeeded: 0, retrying: 0, failed: 0, abandoned: 0, stale: 0 };
  if (claimed.length === 0) return counts;
  const endpoints = new Map((await prisma.webhookEndpoint.findMany({ where: { id: { in: [...new Set(claimed.map((row) => row.endpointId))] } } })).map((row) => [row.id, row]));
  const queue = [...claimed];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        counts[await attempt(next, endpoints)] += 1;
      } catch (err) {
        // The lease expires and another cycle retries it.
        logger.error({ err, deliveryId: next.id }, '[webhooks] recording a delivery attempt failed');
      }
    }
  });
  await Promise.all(workers);
  return counts;
}

export interface DeliveryCycleResult extends Record<AttemptOutcome, number> {
  claimed: number;
}

/** One worker pass: claim up to `limit` due deliveries and attempt them (8 at a time). */
export async function runWebhookDeliveries(options: { limit?: number } = {}): Promise<DeliveryCycleResult> {
  const claimed = await claimDeliveries({ limit: Math.max(1, Math.trunc(options.limit ?? CLAIM_LIMIT)) });
  const counts = await attemptAll(claimed);
  return { claimed: claimed.length, ...counts };
}

/**
 * Attempt one delivery now (test ping, redeliver). Returns null when it was
 * not due or another worker holds it.
 */
export async function attemptDeliveryNow(deliveryId: string): Promise<AttemptOutcome | null> {
  const [claimed] = await claimDeliveries({ limit: 1, deliveryId });
  if (!claimed) return null;
  const counts = await attemptAll([claimed]);
  const outcome = (Object.keys(counts) as AttemptOutcome[]).find((key) => counts[key] > 0);
  return outcome ?? null;
}
