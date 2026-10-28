/**
 * Last-Event-ID replay storage (W04b).
 *
 * The cursor is a stream id (`domain_events.id`). Stream ids become visible
 * in commit order (see stream.ts), so "every authorized event with
 * cursor < id <= boundary, in id order" is complete: nothing below a
 * delivered id can show up later.
 *
 * Pages are bounded twice: at most `pageSize` events per query and at most
 * `scanWindow` ids scanned per query, so a reader far behind or a principal
 * whose events are sparse never triggers an unbounded scan. The cursor of
 * the next page advances past every scanned row, including rows filtered out
 * by authorization, so a fully filtered page can never stall replay. A reader
 * restarted between pages resumes from the id of the last event it received
 * and gets the same remaining sequence.
 *
 * The boundary (`upTo`) splits replay from live delivery: a stream
 * registered with the hub when the process consumer's position is P must
 * replay ids <= P and receive ids > P live. Pass `liveStreamPosition()`
 * captured synchronously at registration. Without it, replay runs to the
 * stream head read when replay starts.
 */
import { prisma, type Prisma } from '@openlinear/db';
import type { TenancyContext } from '../tenancy/types';
import { canReceiveEvent, deniedProjectIds } from '../tenancy/visibility';
import { fromDomainEventRecord, readPrunedThroughId, readStreamHead } from './stream';
import type { PersistedDomainEvent } from './types';

export interface ReplayAudience {
  userId: string;
  teamIds: string[];
  workspaceIds: string[];
  /**
   * The subscriber's current principal. With it, replay applies the same
   * resource policy as live delivery (explicit deny, removed membership).
   * Without it, replay fails closed to rows addressed to `userId` directly.
   */
  principal?: TenancyContext;
}

export const DEFAULT_REPLAY_PAGE_SIZE = 200;
export const DEFAULT_REPLAY_SCAN_WINDOW = 5_000;

export interface ReplayOptions {
  pageSize?: number;
  scanWindow?: number;
  /** Replay ids up to and including this one. Default: the stream head. */
  upTo?: bigint | null;
}

export interface ReplayPage {
  /** Authorized events of this page, in id order. */
  events: PersistedDomainEvent[];
  /** Cursor for the next page (advanced past filtered rows too). */
  nextCursor: bigint;
  /** True when `nextCursor` reached the boundary. */
  done: boolean;
  /** Rows read by this page before authorization filtering. */
  scanned: number;
}

interface AudienceFilter {
  where: Prisma.DomainEventWhereInput;
  accepts: (event: PersistedDomainEvent) => boolean;
}

function audienceFilter(audience: ReplayAudience): AudienceFilter {
  const principal = audience.principal;
  const or: Prisma.DomainEventWhereInput[] = [{ userIds: { has: audience.userId } }];
  if (principal) {
    if (audience.teamIds.length > 0) or.push({ teamIds: { hasSome: audience.teamIds } });
    if (audience.workspaceIds.length > 0) or.push({ workspaceIds: { hasSome: audience.workspaceIds } });
  }
  const denied = principal ? deniedProjectIds(principal) : [];
  const where: Prisma.DomainEventWhereInput = {
    OR: or,
    AND: [
      // Legacy rows carry no binding: only their explicit recipients.
      { OR: [{ resourceType: { not: null } }, { userIds: { has: audience.userId } }] },
      ...(denied.length > 0 ? [{ OR: [{ projectId: null }, { projectId: { notIn: denied } }] }] : []),
    ],
  };
  const accepts = principal
    ? (event: PersistedDomainEvent) => canReceiveEvent(principal, event)
    : (event: PersistedDomainEvent) => event.resourceType === null || event.userIds.includes(audience.userId);
  return { where, accepts };
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

async function readPage(
  cursor: bigint,
  boundary: bigint,
  filter: AudienceFilter,
  pageSize: number,
  scanWindow: number,
): Promise<ReplayPage> {
  if (cursor >= boundary) return { events: [], nextCursor: cursor, done: true, scanned: 0 };
  const windowEnd = minBigInt(cursor + BigInt(scanWindow), boundary);
  const rows = await prisma.domainEvent.findMany({
    where: { AND: [{ id: { gt: cursor, lte: windowEnd } }, filter.where] },
    orderBy: { id: 'asc' },
    take: pageSize,
  });
  const scanned = rows.map(fromDomainEventRecord);
  const last = scanned.at(-1);
  // A full page may stop before the window end; otherwise the whole window
  // was scanned and nothing else in it matches.
  const nextCursor = scanned.length === pageSize && last ? last.id : windowEnd;
  return {
    events: scanned.filter(filter.accepts),
    nextCursor,
    done: nextCursor >= boundary,
    scanned: scanned.length,
  };
}

function resolveSizes(options: ReplayOptions): { pageSize: number; scanWindow: number } {
  return {
    pageSize: Math.min(Math.max(Math.trunc(options.pageSize ?? DEFAULT_REPLAY_PAGE_SIZE), 1), 1_000),
    scanWindow: Math.min(Math.max(Math.trunc(options.scanWindow ?? DEFAULT_REPLAY_SCAN_WINDOW), 1), 100_000),
  };
}

/** One bounded replay page after `cursor`. */
export async function readReplayPage(
  cursor: bigint,
  audience: ReplayAudience,
  options: ReplayOptions = {},
): Promise<ReplayPage> {
  const boundary = options.upTo ?? (await readStreamHead());
  const { pageSize, scanWindow } = resolveSizes(options);
  return readPage(cursor, boundary, audienceFilter(audience), pageSize, scanWindow);
}

/**
 * Every authorized event after `cursor` up to the boundary, page by page
 * (memory stays bounded by one page). The boundary is fixed when iteration
 * starts.
 */
export async function* replayEvents(
  cursor: bigint,
  audience: ReplayAudience,
  options: ReplayOptions = {},
): AsyncGenerator<PersistedDomainEvent, void, undefined> {
  const boundary = options.upTo ?? (await readStreamHead());
  const { pageSize, scanWindow } = resolveSizes(options);
  const filter = audienceFilter(audience);
  let next = cursor;
  for (;;) {
    const page = await readPage(next, boundary, filter, pageSize, scanWindow);
    for (const event of page.events) yield event;
    if (page.done) return;
    next = page.nextCursor;
  }
}

/**
 * Up to `limit` authorized events after `lastId` (compatibility wrapper used
 * by GET /api/events). Unlike the pre-W04b version it pages past filtered
 * rows instead of stopping at the first 200 scanned rows; callers that must
 * drain more than `limit` events should iterate `replayEvents`.
 */
export async function replaySince(
  lastId: bigint,
  audience: ReplayAudience,
  limit = DEFAULT_REPLAY_PAGE_SIZE,
  options: ReplayOptions = {},
): Promise<PersistedDomainEvent[]> {
  const events: PersistedDomainEvent[] = [];
  for await (const event of replayEvents(lastId, audience, options)) {
    events.push(event);
    if (events.length >= limit) break;
  }
  return events;
}

/**
 * True when events after `cursor` were removed by retention, so replay from
 * it cannot be complete and the client should resynchronize its state.
 */
export async function isReplayTruncated(cursor: bigint): Promise<boolean> {
  return cursor < (await readPrunedThroughId());
}

export function parseLastEventId(raw: unknown): bigint | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const value = BigInt(raw.trim());
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

/**
 * SSE replay for one subscriber (W02b on top of W04b storage).
 *
 * Pages forward from `lastId` to the boundary (`upTo`, normally the live
 * stream position captured at registration) and reports a `cursor` that has
 * advanced past every scanned id — visible or filtered — so a reconnect never
 * rescans the same rows (no stall). At most `maxScannedRows` rows are read per
 * connection; when that budget runs out `truncated` is true and the caller
 * hands `cursor` to the client instead of switching to live delivery.
 */
export interface ReplayLimits {
  /** Rows per query. */
  pageSize: number;
  /** Rows examined per connection before handing the cursor to the client. */
  maxScannedRows: number;
}

const DEFAULT_LIMITS: ReplayLimits = {
  pageSize: DEFAULT_REPLAY_PAGE_SIZE,
  maxScannedRows: DEFAULT_REPLAY_SCAN_WINDOW,
};
let limits: ReplayLimits = DEFAULT_LIMITS;

/** Test seam. `null` restores the defaults. */
export function setReplayLimits(next: Partial<ReplayLimits> | null): void {
  limits = next ? { ...DEFAULT_LIMITS, ...next } : DEFAULT_LIMITS;
}

export interface ReplayResult {
  /** Rows the principal may receive, in id order. */
  events: PersistedDomainEvent[];
  /** Highest id scanned (delivered or filtered); `null` when nothing was scanned past `lastId`. */
  cursor: bigint | null;
  /** The budget ran out before the boundary; more rows may follow `cursor`. */
  truncated: boolean;
}

export async function replayVisibleSince(
  lastId: bigint,
  principal: TenancyContext,
  options: { upTo?: bigint | null } = {},
): Promise<ReplayResult> {
  const audience: ReplayAudience = {
    userId: principal.userId,
    teamIds: [...principal.teams],
    workspaceIds: [...principal.workspaces.keys()],
    principal,
  };
  const boundary = options.upTo ?? (await readStreamHead());
  const filter = audienceFilter(audience);
  const events: PersistedDomainEvent[] = [];
  let cursor = lastId;
  let scanned = 0;
  const result = (truncated: boolean): ReplayResult => ({
    events,
    cursor: cursor > lastId ? cursor : null,
    truncated,
  });
  for (;;) {
    const remaining = limits.maxScannedRows - scanned;
    if (remaining <= 0) return result(true);
    const page = await readPage(
      cursor,
      boundary,
      filter,
      Math.min(limits.pageSize, remaining),
      DEFAULT_REPLAY_SCAN_WINDOW,
    );
    events.push(...page.events);
    scanned += page.scanned;
    cursor = page.nextCursor;
    if (page.done) return result(false);
  }
}
