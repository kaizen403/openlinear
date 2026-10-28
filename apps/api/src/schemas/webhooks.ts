import { z } from 'zod';
import { WEBHOOK_EVENT_TYPES } from '../services/webhook-events';
import { WEBHOOK_FORMATS } from '../services/webhook-formats';
import { MAX_WEBHOOK_URL_LENGTH } from '../services/webhook-network';

/**
 * FE-14 outbound webhooks. The DB CHECKs in migration
 * 20261027265000_fe14_webhooks and 20261027280000_fe14_webhook_formats_digests
 * mirror these bounds; the URL rules (https, public host, Slack / Discord
 * URLs per format) live in services/webhook-network.ts and
 * services/webhook-formats.ts, the time-zone check in webhook-digest.ts.
 */

export const MAX_WEBHOOK_DESCRIPTION = 200;
export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'succeeded', 'failed', 'abandoned'] as const;

const url = z.string().trim().min(1).max(MAX_WEBHOOK_URL_LENGTH);
const description = z.string().trim().max(MAX_WEBHOOK_DESCRIPTION).nullable();
const eventTypes = z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length)
  .transform((types) => [...new Set(types)]);
/** openlinear (signed JSON, default) | slack | discord. */
const format = z.enum(WEBHOOK_FORMATS);
/** `digest.daily`: the local hour of the digest, 0-23 (default 9). */
const digestHour = z.number().int().min(0).max(23);
/** `digest.daily`: IANA zone of the digest hour (default UTC). */
const digestTimezone = z.string().trim().min(1).max(64);

export const createWebhookBodySchema = z.object({
  url,
  description: description.optional(),
  eventTypes,
  format: format.optional(),
  digestHour: digestHour.optional(),
  digestTimezone: digestTimezone.optional(),
}).strict();

export const updateWebhookBodySchema = z.object({
  url: url.optional(),
  description: description.optional(),
  eventTypes: eventTypes.optional(),
  format: format.optional(),
  digestHour: digestHour.optional(),
  digestTimezone: digestTimezone.optional(),
  /** false turns the endpoint off; true turns it back on (failure count reset). */
  active: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, { message: 'Nothing to update' });

export const listWebhookDeliveriesQuerySchema = z.object({
  /** Opaque, from `nextCursor`. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
}).strict();

export type CreateWebhookBody = z.infer<typeof createWebhookBodySchema>;
export type UpdateWebhookBody = z.infer<typeof updateWebhookBodySchema>;
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;
