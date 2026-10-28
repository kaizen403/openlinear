import { prisma, type Prisma } from '@openlinear/db';
import { PRISMA_TX_OPTIONS } from '../lib/constants';

/**
 * Activity feed reads (P95 Phase 1, perf1).
 *
 * The feed is ordered newest first with `id` as a tiebreaker, so
 * `(createdAt, id)` is a total order and the `activity_logs_createdAt_id_idx`
 * index can serve both the first page and every keyset page without a sort.
 *
 * Paging:
 *   - `cursor` (opaque, from `nextCursor`) seeks with an index condition
 *     (`createdAt <= c.createdAt`) plus a tiebreak filter, so page N costs the
 *     same as page 1;
 *   - `page`/`pageSize` without a cursor keeps the old OFFSET behaviour for
 *     existing clients.
 *
 * `hasMore` is exact (one extra row is read). The exact `COUNT(*)` of all
 * visible activity is no longer computed by default (it was a full scan of the
 * table on every request): `total` is then the number of rows up to and
 * including this page, `totalExact: false`. `count=exact` restores the exact
 * total for callers that need it.
 */

export const ACTIVITY_COUNT_MODES = ['none', 'exact'] as const;
export type ActivityCountMode = (typeof ACTIVITY_COUNT_MODES)[number];

export interface ActivityCursor {
  createdAt: Date;
  id: string;
}

const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9A-Za-z-]{1,64})$/;

export function encodeActivityCursor(row: ActivityCursor): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/** `null` when the cursor is malformed (callers answer 400). */
export function decodeActivityCursor(raw: string): ActivityCursor | null {
  if (raw.length === 0 || raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const match = CURSOR_PATTERN.exec(Buffer.from(raw, 'base64url').toString('utf8'));
  if (!match) return null;
  const createdAt = new Date(match[1]);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: match[2] };
}

/** Rows strictly after `cursor` in (createdAt DESC, id DESC) order. */
function afterCursor(cursor: ActivityCursor): Prisma.ActivityLogWhereInput {
  return {
    AND: [
      // Index condition: lets Postgres start the scan at the cursor.
      { createdAt: { lte: cursor.createdAt } },
      // Tiebreak among rows that share the cursor's timestamp.
      { OR: [{ createdAt: { lt: cursor.createdAt } }, { id: { lt: cursor.id } }] },
    ],
  };
}

const activityInclude = {
  user: { select: { id: true, username: true, avatarUrl: true } },
} satisfies Prisma.ActivityLogInclude;

export type ActivityRow = Prisma.ActivityLogGetPayload<{ include: typeof activityInclude }>;

export interface ActivityPage {
  items: ActivityRow[];
  total: number;
  totalExact: boolean;
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export async function listActivityPage(input: {
  where: Prisma.ActivityLogWhereInput;
  page: number;
  pageSize: number;
  cursor: ActivityCursor | null;
  count: ActivityCountMode;
}): Promise<ActivityPage> {
  const { where, page, pageSize, cursor, count } = input;
  const offset = cursor ? 0 : (page - 1) * pageSize;
  const query: Prisma.ActivityLogFindManyArgs & { include: typeof activityInclude } = {
    where: cursor ? { AND: [where, afterCursor(cursor)] } : where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip: offset,
    take: pageSize + 1,
    include: activityInclude,
  };

  let rows: ActivityRow[];
  let exactTotal: number | null = null;
  if (count === 'exact') {
    [rows, exactTotal] = await prisma.$transaction(
      async (tx) => [await tx.activityLog.findMany(query), await tx.activityLog.count({ where })] as const,
      PRISMA_TX_OPTIONS,
    );
  } else {
    rows = await prisma.activityLog.findMany(query);
  }

  const hasMore = rows.length > pageSize;
  const items = hasMore ? rows.slice(0, pageSize) : rows;
  const last = items.at(-1);
  return {
    items,
    total: exactTotal ?? offset + items.length,
    totalExact: exactTotal !== null,
    page,
    pageSize,
    hasMore,
    nextCursor: hasMore && last ? encodeActivityCursor(last) : null,
  };
}
