import { deliverLocalEvent } from '../sse/local';
import type { AttemptEventRelay, RelayedEventType } from './relay';

/**
 * One publication point for execution events (replaces the sidecar's former
 * in-process use of the cloud API's SSE/outbox module).
 *
 * - Local delivery (the sidecar's own `/api/events`) goes only to streams of
 *   the run's owner — the principal that started it and was authorized for it.
 *   An event whose task has no known owner is not delivered locally (fail
 *   closed).
 * - Progress and log events of an attempt are also relayed to the control
 *   plane, which re-authorizes every cloud subscriber against the task's
 *   resource binding (W02a).
 */
type OwnerResolver = (taskId: string) => string | null | undefined;

const ownerResolvers: OwnerResolver[] = [];
const relays = new Map<string, AttemptEventRelay>();

export function registerTaskOwnerResolver(resolver: OwnerResolver): void {
  ownerResolvers.push(resolver);
}

export function resolveTaskOwner(taskId: string): string | null {
  for (const resolver of ownerResolvers) {
    const owner = resolver(taskId);
    if (owner) return owner;
  }
  return null;
}

export function attachAttemptRelay(taskId: string, relay: AttemptEventRelay): void {
  relays.set(taskId, relay);
}

/** Detach only if `relay` is still the task's relay (a replacement keeps its own). */
export function detachAttemptRelay(taskId: string, relay: AttemptEventRelay): void {
  if (relays.get(taskId) === relay) relays.delete(taskId);
}

export function getAttemptRelay(taskId: string): AttemptEventRelay | undefined {
  return relays.get(taskId);
}

function isRelayed(event: string): event is RelayedEventType {
  return event === 'execution:progress' || event === 'execution:log';
}

export function publishTaskEvent(
  taskId: string,
  event: string,
  payload: Record<string, unknown>,
  options: { ownerUserId?: string | null } = {},
): void {
  const owner = options.ownerUserId ?? resolveTaskOwner(taskId);
  if (owner) deliverLocalEvent(event, payload, { userId: owner });
  if (isRelayed(event)) relays.get(taskId)?.enqueue(event, payload);
}

export function publishUserEvent(userId: string, event: string, payload: unknown): void {
  deliverLocalEvent(event, payload, { userId });
}

/** Non-tenant data only (OpenCode server status). */
export function publishGlobalEvent(event: string, payload: unknown): void {
  deliverLocalEvent(event, payload, 'all');
}
