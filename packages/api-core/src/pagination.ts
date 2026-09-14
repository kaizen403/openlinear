export interface CursorPage {
  limit: number;
  cursor: string | undefined;
}

export function parseCursorPagination(
  query: { limit?: unknown; cursor?: unknown },
  defaultLimit = 50,
  maxLimit = 200,
): CursorPage {
  const rawLimit = query.limit;
  const parsedLimit =
    typeof rawLimit === "string" && rawLimit.trim()
      ? Number.parseInt(rawLimit, 10)
      : defaultLimit;
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    throw new Error("limit must be a positive integer");
  }
  const rawCursor = query.cursor;
  if (rawCursor !== undefined && typeof rawCursor !== "string") {
    throw new Error("cursor must be a string");
  }
  return {
    limit: Math.min(parsedLimit, maxLimit),
    cursor: rawCursor,
  };
}

export interface OffsetPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export function paginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): OffsetPage<T> {
  return {
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}
