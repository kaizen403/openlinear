/**
 * Deterministic `Idempotency-Key` derivation for MCP writes.
 *
 * A key is `mcp1.<step>.<hex>` where `<hex>` is the SHA-256 of the canonical
 * JSON (sorted object keys, `undefined` dropped, array order kept) of
 * `{ v: 1, tool, step, material }`. `material` is the tool's validated
 * arguments (including the optional caller-supplied `idempotencyKey`) plus,
 * for multi-step tools, the ids the step depends on.
 *
 * Consequences:
 * - Retrying a call with identical arguments (a client retry after a timeout,
 *   a reconnect, or the model repeating the call) reuses the same keys, so
 *   the OpenLinear API replays the stored result instead of writing again.
 * - Any change to the arguments yields a new key, so a different request
 *   never reuses a key (no stale replay, no `409 IDEMPOTENCY_CONFLICT`).
 * - A caller that really wants a second identical item passes a fresh
 *   `idempotencyKey` argument.
 * - Keys are scoped by the API per credential (each PAT on its own),
 *   workspace and operation, and kept 24 h (`idempotency_records`, W04a/W04b:
 *   tasks, task bulk creation, projects and teams).
 *
 * The output satisfies the API contract: 8–128 characters from
 * `A-Za-z0-9._:~+/=-`.
 */

const STEP_PATTERN = /^[a-z0-9][a-z0-9.-]{0,40}$/;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deriveIdempotencyKey(tool: string, step: string, material: unknown): Promise<string> {
  if (!STEP_PATTERN.test(step)) throw new Error(`Invalid idempotency step "${step}"`);
  const hex = await sha256Hex(canonicalJson({ v: 1, tool, step, material }));
  return `mcp1.${step}.${hex}`;
}
