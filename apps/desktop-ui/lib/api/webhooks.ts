import { apiFetch } from './fetch';
import { idempotencyHeaders } from './idempotency';

/**
 * FE-14 outbound webhooks (apps/api `/api/projects/:id/webhooks`,
 * `/api/workspaces/:id/webhooks`, `/api/webhooks/:id`). OpenLinear POSTs a
 * body to the endpoint for each subscribed event — signed OpenLinear JSON,
 * or a Slack / Discord message — retries with backoff and keeps a delivery
 * history. `digest.daily` sends one summary a day at a chosen local hour.
 * Creating an endpoint and rotating its secret return the secret once.
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
  'digest.daily',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** What each event means, for the picker. */
export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  'issue.created': 'Issue created',
  'issue.updated': 'Issue updated',
  'issue.done': 'Issue done',
  'issue.deleted': 'Issue deleted',
  'run.succeeded': 'Agent run succeeded',
  'run.failed': 'Agent run failed',
  'run.cancelled': 'Agent run cancelled',
  'plan.approved': 'Plan approved',
  'schedule.fired': 'Recurring issue created',
  'digest.daily': 'Daily digest',
};

export const WEBHOOK_FORMATS = ['openlinear', 'slack', 'discord'] as const;

export type WebhookFormat = (typeof WEBHOOK_FORMATS)[number];

export const WEBHOOK_FORMAT_LABELS: Record<WebhookFormat, string> = {
  openlinear: 'OpenLinear JSON',
  slack: 'Slack',
  discord: 'Discord',
};

/** What each format sends, for the picker. */
export const WEBHOOK_FORMAT_HELP: Record<WebhookFormat, string> = {
  openlinear: 'Signed JSON with the event data, for your own service.',
  slack: 'A short message with a link, for a Slack incoming webhook.',
  discord: 'A short message with a link, for a Discord channel webhook.',
};

export const WEBHOOK_FORMAT_PLACEHOLDERS: Record<WebhookFormat, string> = {
  openlinear: 'https://example.com/hooks/openlinear',
  slack: 'https://hooks.slack.com/services/…',
  discord: 'https://discord.com/api/webhooks/…',
};

export function isWebhookFormat(value: string): value is WebhookFormat {
  return (WEBHOOK_FORMATS as readonly string[]).includes(value);
}

/** Where a webhook belongs: one project, or every project of a workspace. */
export type WebhookScope = { kind: 'project'; projectId: string } | { kind: 'workspace'; workspaceId: string };

export type WebhookDisabledReason = 'manual' | 'consecutive_failures' | 'owner_lost_access';

export interface Webhook {
  id: string;
  scope: 'project' | 'workspace';
  projectId: string | null;
  workspaceId: string | null;
  /** Full URL for people who may manage the endpoint; null for everyone else. */
  url: string | null;
  /** Origin plus "/…" (paths often carry tokens). */
  urlDisplay: string;
  description: string | null;
  eventTypes: string[];
  /** Older servers omit it: treat as `openlinear`. */
  format?: WebhookFormat | string;
  /** `digest.daily`: local hour (0-23) and IANA zone. */
  digestHour?: number | null;
  digestTimezone?: string | null;
  /** When the next digest is due (null while off or not subscribed). */
  digestNextAt?: string | null;
  secretPrefix: string;
  /** Until when the previous secret also signs, after a rotation. */
  previousSecretExpiresAt: string | null;
  active: boolean;
  disabledAt: string | null;
  disabledReason: WebhookDisabledReason | string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  ownerId: string;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

/** Create and rotate answer with the secret, once. */
export interface WebhookWithSecret extends Webhook {
  secret: string;
}

export interface WebhookList {
  items: Webhook[];
  canManage: boolean;
  eventTypes: string[];
  formats?: string[];
  limits: { endpoints: number; maxAttempts: number; retryDelaysMs: number[] };
}

export type WebhookDeliveryStatus = 'pending' | 'succeeded' | 'failed' | 'abandoned';

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  inFlight: boolean;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  lastDurationMs: number | null;
  deliveredAt: string | null;
  redeliveries: number;
  createdAt: string;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  payload: string;
  lastResponseExcerpt: string | null;
}

export interface WebhookDeliveryPage {
  items: WebhookDelivery[];
  nextCursor: string | null;
}

export interface WebhookInput {
  url: string;
  description: string | null;
  eventTypes: WebhookEventType[];
  format: WebhookFormat;
  /** Sent with `digest.daily`: the local hour and IANA zone of the digest. */
  digestHour?: number;
  digestTimezone?: string;
}

/**
 * Query keys, under the project scope so project-wide invalidation reaches
 * them. (Kept here until they move into `lib/query/keys.ts`.)
 */
export const webhookKeys = {
  list: (projectId: string) => ['ol', 'project', projectId, 'webhooks', 'list'] as const,
  workspaceList: (workspaceId: string) => ['ol', 'workspace', workspaceId, 'webhooks', 'list'] as const,
  forScope: (scope: WebhookScope) => (scope.kind === 'project' ? webhookKeys.list(scope.projectId) : webhookKeys.workspaceList(scope.workspaceId)),
  deliveries: (webhookId: string, status: WebhookDeliveryStatus | 'all') => ['ol', 'webhooks', webhookId, 'deliveries', status] as const,
  delivery: (webhookId: string, deliveryId: string) => ['ol', 'webhooks', webhookId, 'deliveries', 'one', deliveryId] as const,
};

const path = (webhookId: string, suffix = '') => `/api/webhooks/${encodeURIComponent(webhookId)}${suffix}`;

export function fetchProjectWebhooks(projectId: string): Promise<WebhookList> {
  return apiFetch<WebhookList>(`/api/projects/${encodeURIComponent(projectId)}/webhooks`);
}

/** Keyed: a retry with the same key and body returns the same endpoint and secret. */
export function createProjectWebhook(projectId: string, body: WebhookInput, idempotencyKey: string): Promise<WebhookWithSecret> {
  return apiFetch<WebhookWithSecret>(`/api/projects/${encodeURIComponent(projectId)}/webhooks`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: idempotencyHeaders(idempotencyKey),
  });
}

/** Webhooks for every project of a workspace (owners and admins manage them). */
export function fetchWorkspaceWebhooks(workspaceId: string): Promise<WebhookList> {
  return apiFetch<WebhookList>(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks`);
}

/** Keyed, like `createProjectWebhook`. */
export function createWorkspaceWebhook(workspaceId: string, body: WebhookInput, idempotencyKey: string): Promise<WebhookWithSecret> {
  return apiFetch<WebhookWithSecret>(`/api/workspaces/${encodeURIComponent(workspaceId)}/webhooks`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: idempotencyHeaders(idempotencyKey),
  });
}

/** Any subset; `active: false` turns it off, `true` back on. You become its owner. */
export function updateWebhook(webhookId: string, body: Partial<WebhookInput> & { active?: boolean }): Promise<Webhook> {
  return apiFetch<Webhook>(path(webhookId), { method: 'PATCH', body: JSON.stringify(body) });
}

export function deleteWebhook(webhookId: string): Promise<void> {
  return apiFetch<void>(path(webhookId), { method: 'DELETE' });
}

/** New secret, shown once; the old one keeps signing for 24 hours. */
export function rotateWebhookSecret(webhookId: string): Promise<WebhookWithSecret> {
  return apiFetch<WebhookWithSecret>(path(webhookId, '/rotate-secret'), { method: 'POST' });
}

/** One signed `ping`, sent right away; the answer carries its result. */
export function pingWebhook(webhookId: string): Promise<WebhookDeliveryDetail> {
  return apiFetch<WebhookDeliveryDetail>(path(webhookId, '/ping'), { method: 'POST' });
}

export function fetchWebhookDeliveries(webhookId: string, options: { cursor?: string | null; limit?: number; status?: WebhookDeliveryStatus } = {}): Promise<WebhookDeliveryPage> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit) query.set('limit', String(options.limit));
  if (options.status) query.set('status', options.status);
  const search = query.toString();
  return apiFetch<WebhookDeliveryPage>(path(webhookId, `/deliveries${search ? `?${search}` : ''}`));
}

export function fetchWebhookDelivery(webhookId: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
  return apiFetch<WebhookDeliveryDetail>(path(webhookId, `/deliveries/${encodeURIComponent(deliveryId)}`));
}

/** Same delivery id and body again, attempted right away. */
export function redeliverWebhookDelivery(webhookId: string, deliveryId: string): Promise<WebhookDeliveryDetail> {
  return apiFetch<WebhookDeliveryDetail>(path(webhookId, `/deliveries/${encodeURIComponent(deliveryId)}/redeliver`), { method: 'POST' });
}

// ── Wording ────────────────────────────────────────────────────────────────

export function eventTypeLabel(type: string): string {
  if (type === 'ping') return 'Test ping';
  return (WEBHOOK_EVENT_LABELS as Record<string, string>)[type] ?? type;
}

export function webhookFormatOf(webhook: Pick<Webhook, 'format'>): WebhookFormat {
  return webhook.format && isWebhookFormat(webhook.format) ? webhook.format : 'openlinear';
}

/** "09:00" for an hour. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** "Daily digest at 09:00 (Europe/Berlin)", or null when the webhook has no digest. */
export function digestScheduleText(webhook: Pick<Webhook, 'eventTypes' | 'digestHour' | 'digestTimezone'>): string | null {
  if (!webhook.eventTypes.includes('digest.daily') || webhook.digestHour === null || webhook.digestHour === undefined) return null;
  return `Daily digest at ${hourLabel(webhook.digestHour)} (${webhook.digestTimezone ?? 'UTC'})`;
}

/** The device's IANA zone, the default for a new digest. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** IANA zones the runtime knows (for the digest zone picker), always including `current`. */
export function timeZoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] };
    zones = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    zones = [];
  }
  const all = new Set(['UTC', ...zones]);
  if (current) all.add(current);
  return [...all].sort((a, b) => (a === 'UTC' ? -1 : b === 'UTC' ? 1 : a.localeCompare(b)));
}

/** Why an endpoint is off, in words (null while it is on). */
export function disabledReasonText(webhook: Pick<Webhook, 'active' | 'disabledReason'>): string | null {
  if (webhook.active) return null;
  if (webhook.disabledReason === 'consecutive_failures') return 'Turned off automatically after 20 failed deliveries in a row. Fix the receiver, send a test ping, then turn it back on.';
  if (webhook.disabledReason === 'owner_lost_access') return 'Turned off automatically: the person who set it up can no longer manage webhooks here. Turning it back on makes you its owner.';
  return 'Turned off. Events are not sent while it is off.';
}

/** "Retry at 14:05" / "Sending…" / "Delivered" and so on, for one delivery. */
export function deliveryStatusText(delivery: Pick<WebhookDelivery, 'status' | 'attempts' | 'nextAttemptAt' | 'inFlight'>, format: (iso: string) => string = formatTime): string {
  if (delivery.inFlight) return 'Sending…';
  switch (delivery.status) {
    case 'succeeded':
      return 'Delivered';
    case 'failed':
      return 'Failed';
    case 'abandoned':
      return 'Not sent (webhook off)';
    default:
      if (delivery.attempts === 0 || !delivery.nextAttemptAt) return 'Queued';
      return `Retry at ${format(delivery.nextAttemptAt)}`;
  }
}

/** "Oct 28, 14:05" in the device's zone. */
export function formatTime(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) }).format(date);
}

/** The body as the receiver got it, indented for reading. */
export function prettyPayload(payload: string): string {
  try {
    return JSON.stringify(JSON.parse(payload), null, 2);
  } catch {
    return payload;
  }
}

/** Client-side check before sending (the server applies the full rules, including which URLs a format accepts). */
export function webhookUrlHint(raw: string, format: WebhookFormat = 'openlinear'): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Enter a full URL, e.g. ${WEBHOOK_FORMAT_PLACEHOLDERS[format]}`;
  }
  if (url.protocol !== 'https:') return 'Webhook URLs must use https://';
  if (url.username || url.password) return 'Remove the user name and password from the URL';
  if (format === 'slack' && !(url.hostname === 'hooks.slack.com' && url.pathname.startsWith('/services/'))) {
    return 'Use the Slack incoming webhook URL (https://hooks.slack.com/services/…)';
  }
  if (format === 'discord' && !((url.hostname === 'discord.com' || url.hostname === 'discordapp.com') && url.pathname.startsWith('/api/webhooks/'))) {
    return 'Use the Discord channel webhook URL (https://discord.com/api/webhooks/…)';
  }
  return null;
}
