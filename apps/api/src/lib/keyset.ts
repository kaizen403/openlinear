/**
 * Opaque keyset cursors for lists ordered by `createdAt DESC, id DESC`.
 *
 * The token is base64url JSON `{ v: 1, c: <createdAt ISO>, i: <id> }`: the
 * position of the last row of a page. The next page is every row strictly
 * after it in that order, so rows inserted while a client pages (which get a
 * newer `createdAt`) never shift later pages: rows that existed when paging
 * started are returned exactly once, in order.
 *
 * Clients must treat the token as opaque; the format may change (`v`).
 */
import { HttpError } from '../errors';

export interface KeysetPosition {
  createdAt: Date;
  id: string;
}

const CURSOR_VERSION = 1;
const ID_PATTERN = /^[0-9a-fA-F-]{1,64}$/;

export function encodeKeysetCursor(row: KeysetPosition): string {
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, c: row.createdAt.toISOString(), i: row.id }),
    'utf8',
  ).toString('base64url');
}

function invalidCursor(): HttpError {
  return new HttpError(400, 'INVALID_CURSOR', 'cursor is not a valid pagination token; restart from the first page');
}

/** Decode a cursor; 400 `INVALID_CURSOR` for anything that is not one of ours. */
export function decodeKeysetCursor(token: string): KeysetPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalidCursor();
  const { v, c, i } = parsed as { v?: unknown; c?: unknown; i?: unknown };
  if (v !== CURSOR_VERSION || typeof c !== 'string' || typeof i !== 'string' || !ID_PATTERN.test(i)) {
    throw invalidCursor();
  }
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) throw invalidCursor();
  return { createdAt, id: i };
}
