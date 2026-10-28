/**
 * Two-step confirmation for destructive chat tools (W18a).
 *
 * The first call resolves the exact selection read-only and issues a code
 * such as `CONFIRM-7KQ2MX9P`. The code is:
 *  - server-issued and random (40 bits, Crockford base32), stored only as a
 *    SHA-256 digest;
 *  - single-use (claimed by a conditional update, so concurrent redemptions
 *    cannot both succeed);
 *  - short-lived (10 minutes);
 *  - bound to the session, user, tool and a hash of the exact change and the
 *    targets' current revisions, so a different selection, changed arguments or
 *    a concurrent edit to any target invalidates it;
 *  - redeemable only when it appears in the authenticated user's own message
 *    for the current turn. Model narration, tool output and workspace text can
 *    never confirm on the user's behalf.
 */
import { createHash, randomInt } from 'node:crypto';
import { prisma } from '@openlinear/db';
import { fail, toJsonInput, type ConfirmationBinding, type JsonObject, type ToolContext, type ToolResult } from './types';

export const CONFIRMATION_TTL_MS = 10 * 60_000;

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const CODE_BODY = '[0-9A-HJKMNP-TV-Z]{8}';
const CODE_IN_TEXT = new RegExp(`\\bCONFIRM-(${CODE_BODY})\\b`, 'gi');
const CODE_EXACT = new RegExp(`^\\s*CONFIRM-(${CODE_BODY})\\s*$`, 'i');

export function generateConfirmationCode(): string {
  let body = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `CONFIRM-${body}`;
}

/** Canonical upper-case form, or null when `code` is not a confirmation code. */
export function normalizeConfirmationCode(code: string): string | null {
  const match = CODE_EXACT.exec(code);
  return match?.[1] ? `CONFIRM-${match[1].toUpperCase()}` : null;
}

export function extractConfirmationCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const match of text.matchAll(CODE_IN_TEXT)) {
    if (match[1]) codes.add(`CONFIRM-${match[1].toUpperCase()}`);
  }
  return [...codes];
}

/** Codes the user supplied this turn: typed in the message or sent as structured tokens. */
export function collectUserConfirmations(message: string, structured: readonly string[] = []): ReadonlySet<string> {
  const codes = new Set(extractConfirmationCodes(message));
  for (const token of structured) {
    const normalized = normalizeConfirmationCode(token);
    if (normalized) codes.add(normalized);
  }
  return codes;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashConfirmationCode(code: string): string {
  return sha256(`openlinear-chat-confirmation:${code}`);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function confirmationBindingHash(binding: ConfirmationBinding): string {
  const targets = [...binding.targets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sha256(JSON.stringify(canonical({
    toolName: binding.toolName,
    projectId: binding.projectId,
    change: binding.change,
    targets,
  })));
}

/** Issue a code for `binding` and return the CONFIRMATION_REQUIRED tool result. */
export async function issueConfirmation(
  ctx: ToolContext,
  binding: ConfirmationBinding,
  summary: string,
  preview: JsonObject,
): Promise<ToolResult> {
  const code = generateConfirmationCode();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + CONFIRMATION_TTL_MS);
  const row = await prisma.chatToolConfirmation.create({
    data: {
      sessionId: ctx.sessionId,
      userId: ctx.userId,
      workspaceId: ctx.workspaceId,
      projectId: binding.projectId,
      toolName: binding.toolName,
      codeHash: hashConfirmationCode(code),
      bindingHash: confirmationBindingHash(binding),
      selection: toJsonInput({ summary, change: binding.change, targets: binding.targets }),
      issuedTurnId: ctx.turnId ?? null,
      issuedToolCallId: ctx.journalKey ?? ctx.toolCallId,
      expiresAt,
      createdAt,
    },
    select: { id: true },
  });
  return fail(
    'CONFIRMATION_REQUIRED',
    `${summary}. Nothing has changed yet. Show the user this preview and ask them to reply with ${code} to proceed. `
      + `Only after their own message contains ${code}, call ${binding.toolName} again with the same arguments and confirmationToken "${code}". The code expires in 10 minutes.`,
    {
      confirmation: { id: row.id, code, expiresAt: expiresAt.toISOString() },
      summary,
      preview,
    },
  );
}

export type RedeemOutcome = { ok: true; confirmationId: string } | { ok: false; result: ToolResult };

function refuse(code: string, message: string): RedeemOutcome {
  return { ok: false, result: fail(code, message) };
}

/**
 * Validate and atomically consume a code for exactly `binding`. Checks run
 * before anything is consumed, so a stale or mistaken call leaves the code
 * usable (until it expires) after a fresh preview is shown.
 */
export async function redeemConfirmation(
  ctx: ToolContext,
  rawCode: string,
  binding: ConfirmationBinding,
): Promise<RedeemOutcome> {
  const code = normalizeConfirmationCode(rawCode);
  if (!code) {
    return refuse('CONFIRMATION_INVALID', 'confirmationToken is not a valid confirmation code. Call the tool without confirmationToken to get a preview.');
  }
  if (!ctx.userConfirmations?.has(code)) {
    return refuse(
      'CONFIRMATION_NOT_FROM_USER',
      `The user's latest message does not contain ${code}. Show the user the preview and ask them to reply with the code; only the user can confirm.`,
    );
  }
  const row = await prisma.chatToolConfirmation.findUnique({ where: { codeHash: hashConfirmationCode(code) } });
  if (!row || row.sessionId !== ctx.sessionId || row.userId !== ctx.userId || row.toolName !== binding.toolName) {
    return refuse('CONFIRMATION_INVALID', 'This confirmation code was not issued for this tool in this conversation. Call the tool without confirmationToken to get a preview.');
  }
  if (row.revokedAt) {
    return refuse('CONFIRMATION_REVOKED', 'The user dismissed this preview, so its code no longer works. Do not retry; ask the user what they want instead.');
  }
  if (row.consumedAt) {
    return refuse('CONFIRMATION_USED', 'This confirmation code has already been used. Call the tool without confirmationToken to get a new preview.');
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return refuse('CONFIRMATION_EXPIRED', 'This confirmation code has expired. Call the tool without confirmationToken to get a new preview.');
  }
  if (row.issuedTurnId && ctx.turnId && row.issuedTurnId === ctx.turnId) {
    return refuse('CONFIRMATION_REQUIRES_USER_TURN', 'A confirmation cannot be used in the turn that issued it. Wait for the user to reply.');
  }
  if (row.bindingHash !== confirmationBindingHash(binding)) {
    return refuse(
      'CONFIRMATION_STALE',
      'The selection or the change no longer matches the confirmed preview (the issues changed, or the arguments differ). Call the tool again without confirmationToken to get a fresh preview.',
    );
  }
  const now = new Date();
  const claimed = await prisma.chatToolConfirmation.updateMany({
    where: { id: row.id, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: {
      consumedAt: now,
      consumedTurnId: ctx.turnId ?? null,
      consumedToolCallId: ctx.journalKey ?? ctx.toolCallId,
    },
  });
  if (claimed.count !== 1) {
    const current = await prisma.chatToolConfirmation.findUnique({ where: { id: row.id }, select: { revokedAt: true } });
    if (current?.revokedAt) {
      return refuse('CONFIRMATION_REVOKED', 'The user dismissed this preview, so its code no longer works. Do not retry; ask the user what they want instead.');
    }
    return refuse('CONFIRMATION_USED', 'This confirmation code has already been used. Call the tool without confirmationToken to get a new preview.');
  }
  return { ok: true, confirmationId: row.id };
}

export type ConfirmationState = 'pending' | 'used' | 'revoked' | 'expired';

export interface ConfirmationSummary {
  id: string;
  toolName: string;
  state: ConfirmationState;
  expiresAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
}

function stateOf(row: { consumedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: number): ConfirmationState {
  if (row.consumedAt) return 'used';
  if (row.revokedAt) return 'revoked';
  if (row.expiresAt.getTime() <= now) return 'expired';
  return 'pending';
}

function summarize(row: { id: string; toolName: string; consumedAt: Date | null; revokedAt: Date | null; expiresAt: Date }, now: number): ConfirmationSummary {
  return {
    id: row.id,
    toolName: row.toolName,
    state: stateOf(row, now),
    expiresAt: row.expiresAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

export type RevokeOutcome =
  | { ok: true; confirmation: ConfirmationSummary }
  | { ok: false; code: 'CONFIRMATION_INVALID' | 'CONFIRMATION_USED'; message: string; confirmation?: ConfirmationSummary };

/**
 * Revoke a code the user dismissed, so it can never be redeemed later (W18a).
 * Idempotent for an already revoked or expired code; refused for a code that
 * already ran or that this user/session did not receive. The update is
 * conditional on `consumedAt IS NULL`, and redemption is conditional on
 * `revokedAt IS NULL`, so a dismiss racing a confirm settles exactly one way.
 */
export async function revokeConfirmation(input: { sessionId: string; userId: string; code: string }): Promise<RevokeOutcome> {
  const code = normalizeConfirmationCode(input.code);
  const row = code ? await prisma.chatToolConfirmation.findUnique({ where: { codeHash: hashConfirmationCode(code) } }) : null;
  if (!row || row.sessionId !== input.sessionId || row.userId !== input.userId) {
    return { ok: false, code: 'CONFIRMATION_INVALID', message: 'No confirmation with this code exists in this chat.' };
  }
  const now = new Date();
  if (!row.consumedAt && !row.revokedAt) {
    await prisma.chatToolConfirmation.updateMany({
      where: { id: row.id, consumedAt: null, revokedAt: null },
      data: { revokedAt: now, revokedById: input.userId },
    });
  }
  const current = await prisma.chatToolConfirmation.findUniqueOrThrow({ where: { id: row.id } });
  const summary = summarize(current, now.getTime());
  if (summary.state === 'used') {
    return { ok: false, code: 'CONFIRMATION_USED', message: 'This change was already confirmed and ran, so it cannot be dismissed.', confirmation: summary };
  }
  return { ok: true, confirmation: summary };
}

/** Confirmations issued in a session (newest first, bounded), for history replay. */
export async function listSessionConfirmations(sessionId: string, limit = 100): Promise<ConfirmationSummary[]> {
  const rows = await prisma.chatToolConfirmation.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { id: true, toolName: true, consumedAt: true, revokedAt: true, expiresAt: true },
  });
  const now = Date.now();
  return rows.map((row) => summarize(row, now));
}
