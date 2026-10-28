import { z } from 'zod';

/**
 * `Idempotency-Key` request header contract (W04a).
 *
 * - 8–128 characters from a token-safe alphabet, so UUIDs, ULIDs and base64url
 *   values fit while whitespace, commas (a repeated header is joined with ", ")
 *   and control characters are rejected.
 * - The structured-field string form from the IETF draft (`"<key>"`) is
 *   accepted and normalised to the bare key, so both spellings name the same
 *   key.
 * - The database enforces the same length bound
 *   (`idempotency_records_key_check`).
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:~+/=-]+$/;

export const idempotencyKeySchema = z
  .string()
  .transform((raw) => {
    const trimmed = raw.trim();
    return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  })
  .pipe(
    z
      .string()
      .min(IDEMPOTENCY_KEY_MIN_LENGTH, `must be at least ${IDEMPOTENCY_KEY_MIN_LENGTH} characters`)
      .max(IDEMPOTENCY_KEY_MAX_LENGTH, `must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`)
      .regex(IDEMPOTENCY_KEY_PATTERN, 'may contain only A-Z a-z 0-9 and . _ : ~ + / = -'),
  );

export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;
