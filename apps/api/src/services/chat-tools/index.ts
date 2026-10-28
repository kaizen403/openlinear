import { createHash } from 'node:crypto';
import { Prisma, prisma } from '@openlinear/db';
import { hasRequiredScopes } from '@openlinear/api-core';
import { isHttpError, isValidationError } from '../../errors';
import { transactionWithEvents } from '../../events/outbox';
import { appendToTarget, userTarget } from '../../events/targets';
import type { ChatLLMFunctionSpec } from '../../lib/chat-llm';
import { logger } from '../../logger';
import { principalFor } from '../../tenancy/context';
import { isOwnershipError } from '../ownership';
import { issueConfirmation, redeemConfirmation } from './confirmations';
import { CHAT_DOMAIN_TOOLS, assertNoToolShapeDrift } from './domain';
import {
  abortCodeFor,
  fail,
  isRecord,
  requiresConfirmation,
  toJsonInput,
  type ChatTool,
  type ChatToolName,
  type ConfirmedChatTool,
  type JsonObject,
  type JsonSchema,
  type ToolContext,
  type ToolEffect,
  type ToolReconciliation,
  type ToolResult,
} from './types';

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Per-tool budget (`CHAT_TOOL_TIMEOUT_MS`, 100 ms – 120 s, default 30 s). A
 * write that outlives it is reported as outcome-unknown and reconciled later;
 * the turn goes on.
 */
function toolTimeoutMs(): number {
  const raw = process.env.CHAT_TOOL_TIMEOUT_MS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_TOOL_TIMEOUT_MS;
  const value = Number(raw);
  return value >= 100 && value <= 120_000 ? value : DEFAULT_TOOL_TIMEOUT_MS;
}

export const CHAT_TOOLS: Record<ChatToolName, ChatTool> = Object.fromEntries(
  CHAT_DOMAIN_TOOLS.map((tool) => [tool.name, tool]),
) as Record<ChatToolName, ChatTool>;

assertNoToolShapeDrift();

/**
 * Tools withheld from the chat agent until human approval exists (Phase 4).
 *
 * These grant or change access. Untrusted text — task titles, descriptions,
 * comments, uploaded files, GitHub content — is fed into the model context
 * undelimited, and every mutating tool runs with no confirmation on
 * model-chosen arguments. A prompt injection planted by any workspace
 * co-tenant could therefore make the victim's own agent grant project access,
 * invite members, or change roles.
 *
 * Withheld rather than merely discouraged: a system-prompt instruction is not
 * an access control. If an operator re-enables them, they are `destructive`
 * and still go through the user-confirmation gate.
 */
export const WITHHELD_PRIVILEGE_TOOLS: ReadonlySet<string> = new Set([
  'grant_project_access',
  'invite_workspace_member',
  'invite_team_member',
  'change_workspace_member_role',
  'change_team_member_role',
]);

function privilegeToolsEnabled(): boolean {
  return process.env.OPENLINEAR_ENABLE_CHAT_PRIVILEGE_TOOLS === '1';
}

export function isToolWithheld(name: string): boolean {
  return WITHHELD_PRIVILEGE_TOOLS.has(name) && !privilegeToolsEnabled();
}

export function getToolEffect(name: string): ToolEffect | null {
  return CHAT_TOOLS[name as ChatToolName]?.effect ?? null;
}

const CONFIRMATION_TOKEN_PARAMETER: JsonSchema = {
  type: 'string',
  description: 'Confirmation code (CONFIRM-XXXXXXXX) from this tool\'s preview, sent only after the user\'s own latest message contains it. Omit to get the preview.',
};

function withConfirmationParameter(parameters: JsonSchema): JsonSchema {
  return { ...parameters, properties: { ...(parameters.properties ?? {}), confirmationToken: CONFIRMATION_TOKEN_PARAMETER } };
}

interface FunctionSpecSet {
  specs: ChatLLMFunctionSpec[];
  hash: string;
}

let specCache: { key: string; value: FunctionSpecSet } | null = null;

/**
 * The tool catalogue sent with every chat request, built once per process
 * configuration. It is the first segment of the prompt prefix providers
 * cache, so it must be byte-identical across requests: a deterministic order,
 * no per-request content, and a hash recorded on every usage row so a
 * catalogue change (a cache invalidation) is visible in the ledger.
 */
function functionSpecSet(): FunctionSpecSet {
  const key = privilegeToolsEnabled() ? 'privilege-tools-enabled' : 'default';
  if (specCache?.key === key) return specCache.value;
  const specs: ChatLLMFunctionSpec[] = CHAT_DOMAIN_TOOLS
    .filter((tool) => !isToolWithheld(tool.name))
    .map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: requiresConfirmation(tool) ? withConfirmationParameter(tool.parameters) : tool.parameters,
      },
    }));
  const value = { specs, hash: createHash('sha256').update(JSON.stringify(specs)).digest('hex') };
  specCache = { key, value };
  return value;
}

/** Shared, immutable-by-convention spec array; callers must not mutate it. */
export function getOpenAIFunctionSpecs(): ChatLLMFunctionSpec[] {
  return functionSpecSet().specs;
}

export function getToolSpecsHash(): string {
  return functionSpecSet().hash;
}

function coerceToolResult(value: unknown): ToolResult {
  if (isRecord(value) && typeof value.ok === 'boolean' && typeof value.code === 'string' && typeof value.message === 'string') {
    return {
      ok: value.ok,
      code: value.code,
      message: value.message,
      ...(value.data !== undefined ? { data: value.data } : {}),
      ...(value.details !== undefined ? { details: value.details } : {}),
    };
  }
  return { ok: true, code: 'OK', message: 'Cached tool result', data: value };
}

/** Raised by `withTimeout` when the tool outlives its budget or the turn is interrupted. */
class ToolInterruptedError extends Error {
  constructor(readonly code: 'TOOL_TIMEOUT' | 'CLIENT_ABORTED' | 'TURN_TIMEOUT' | 'TURN_LEASE_LOST', message: string) {
    super(message);
    this.name = 'ToolInterruptedError';
  }
}

const INTERRUPTION_MESSAGES: Record<ReturnType<typeof abortCodeFor>, string> = {
  TURN_TIMEOUT: 'The chat turn exceeded its time limit',
  TURN_LEASE_LOST: 'The chat turn lost its session lease',
  CLIENT_ABORTED: 'Chat request was aborted',
};

function errorToToolResult(error: unknown): ToolResult {
  if (error instanceof ToolInterruptedError) {
    return fail(error.code, error.message);
  }
  if (isOwnershipError(error)) {
    return fail(error.code, error.reason === 'not_found' ? 'Resource not found' : 'Required role is missing', {
      resourceType: error.resourceType,
      resourceId: error.resourceId,
      requiredRoles: error.requiredRoles,
    });
  }
  if (isValidationError(error)) {
    return fail(error.code, error.message, error.details);
  }
  if (isHttpError(error)) {
    return fail(error.code, error.message, error.details);
  }
  if (error instanceof Error) {
    return fail('TOOL_ERROR', error.message);
  }
  return fail('TOOL_ERROR', 'Tool failed');
}

function isPrismaKnownError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Error && 'code' in error && typeof (error as { code?: unknown }).code === 'string';
}

function interruptionFor(signal: AbortSignal | undefined): ToolInterruptedError {
  const code = abortCodeFor(signal);
  return new ToolInterruptedError(code, INTERRUPTION_MESSAGES[code]);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(interruptionFor(signal));
      return;
    }
    const timeout = setTimeout(() => reject(new ToolInterruptedError('TOOL_TIMEOUT', 'Tool timed out')), timeoutMs);
    timeout.unref?.();
    const onAbort = () => reject(interruptionFor(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function findExistingResult(sessionId: string, journalKey: string): Promise<ToolResult | null> {
  const existing = await prisma.chatToolCall.findUnique({
    where: { sessionId_toolCallId: { sessionId, toolCallId: journalKey } },
    select: { status: true, output: true, errorCode: true, errorMessage: true },
  });
  if (!existing) return null;
  if (existing.status === 'succeeded' && existing.output !== null) return coerceToolResult(existing.output);
  if (existing.status === 'failed') return fail(existing.errorCode ?? 'TOOL_ERROR', existing.errorMessage ?? 'Tool failed');
  if (existing.status === 'cancelled') return fail('CLIENT_ABORTED', 'Previous matching tool call was cancelled');
  return fail('TOOL_CALL_IN_PROGRESS', 'A matching tool call is already running');
}

type JournalStatus = 'succeeded' | 'failed' | 'cancelled';

async function finishJournal(
  sessionId: string,
  journalKey: string,
  result: ToolResult,
  status: JournalStatus,
  startedAt: number,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<void> {
  await db.chatToolCall.updateMany({
    where: { sessionId, toolCallId: journalKey },
    data: {
      status,
      output: toJsonInput(result),
      endedAt: new Date(),
      latencyMs: Date.now() - startedAt,
      errorCode: result.ok ? null : result.code,
      errorMessage: result.ok ? null : result.message,
    },
  });
}

/** SSE event type for a reconciled outcome (user-targeted, durable via the outbox). */
export const TOOL_RECONCILED_EVENT = 'chat:tool:reconciled';

/**
 * A write that was interrupted after it started may still commit. Record its
 * real outcome when it settles, so the journal never claims a failure for a
 * change that happened (W18: timed-out writes have reconcilable outcomes).
 *
 * The journal update and a user-targeted `chat:tool:reconciled` event commit
 * together; the running turn (if its stream is still open) is told through
 * `ctx.onReconciled` and forwards a `tool_reconciled` chunk.
 */
function reconcileLateOutcome(
  execution: Promise<ToolResult>,
  ctx: ToolContext,
  tool: ChatTool,
  journalKey: string,
  startedAt: number,
  interruptedBy: string,
): void {
  const settle = async (result: ToolResult, status: 'succeeded' | 'failed'): Promise<void> => {
    const reconciledAt = new Date().toISOString();
    const reconciliation: ToolReconciliation = {
      toolCallId: ctx.toolCallId,
      journalKey,
      sessionId: ctx.sessionId,
      messageId: ctx.messageId ?? null,
      toolName: tool.name,
      effect: tool.effect,
      status,
      result,
      reconciledAfter: interruptedBy,
      reconciledAt,
    };
    await transactionWithEvents(async (tx) => {
      await finishJournal(ctx.sessionId, journalKey, result, status, startedAt, tx);
      await appendToTarget(tx, userTarget(ctx.userId), TOOL_RECONCILED_EVENT, reconciliation, ctx.userId);
    });
    try {
      ctx.onReconciled?.(reconciliation);
    } catch (err) {
      logger.warn({ err, sessionId: ctx.sessionId, journalKey }, '[chat] reconciliation listener failed');
    }
  };
  execution
    .then(
      (result) => settle(
        { ...result, details: { ...(isRecord(result.details) ? result.details : {}), reconciledAfter: interruptedBy } },
        result.ok ? 'succeeded' : 'failed',
      ),
      (error: unknown) => {
        const result = errorToToolResult(error);
        return settle({ ...result, details: { reconciledAfter: interruptedBy } }, 'failed');
      },
    )
    .catch((err: unknown) => {
      logger.warn({ err, sessionId: ctx.sessionId, journalKey }, '[chat] could not record the late outcome of an interrupted tool call');
    });
}

/**
 * Destructive/external tools: resolve the exact selection, then either issue a
 * confirmation code (first call) or redeem the user's code and execute exactly
 * the bound selection.
 */
async function runConfirmedTool(tool: ConfirmedChatTool, ctx: ToolContext, args: JsonObject): Promise<ToolResult> {
  const { confirmationToken, ...rest } = args;
  const prepared = await tool.prepare(ctx, rest);
  if (prepared.kind === 'result') return prepared.result;
  if (confirmationToken === undefined || confirmationToken === null || confirmationToken === '') {
    return issueConfirmation(ctx, prepared.binding, prepared.summary, prepared.preview);
  }
  if (typeof confirmationToken !== 'string') {
    return fail('CONFIRMATION_INVALID', 'confirmationToken must be the CONFIRM-XXXXXXXX code from the preview');
  }
  const redeemed = await redeemConfirmation(ctx, confirmationToken, prepared.binding);
  if (!redeemed.ok) return redeemed.result;
  const result = await prepared.execute();
  return { ...result, details: { ...(isRecord(result.details) ? result.details : {}), confirmationId: redeemed.confirmationId } };
}

function runTool(tool: ChatTool, ctx: ToolContext, args: JsonObject): Promise<ToolResult> {
  return requiresConfirmation(tool) ? runConfirmedTool(tool, ctx, args) : tool.handler(ctx, args);
}

/** Journal a tool call that is refused before dispatch (e.g. unparseable arguments). */
export async function journalRejectedToolCall(ctx: ToolContext, toolName: string, input: JsonObject, result: ToolResult): Promise<void> {
  const journalKey = ctx.journalKey ?? ctx.toolCallId;
  try {
    await prisma.chatToolCall.create({
      data: {
        sessionId: ctx.sessionId,
        messageId: ctx.messageId ?? undefined,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId ?? undefined,
        toolCallId: journalKey,
        providerToolCallId: ctx.journalKey ? ctx.toolCallId : null,
        turnId: ctx.turnId ?? null,
        toolName: toolName.slice(0, 100),
        effect: getToolEffect(toolName),
        input: toJsonInput(input),
        output: toJsonInput(result),
        status: 'failed',
        endedAt: new Date(),
        latencyMs: 0,
        errorCode: result.code,
        errorMessage: result.message,
      },
    });
  } catch (err) {
    logger.warn({ err, sessionId: ctx.sessionId, journalKey }, '[chat] could not journal a rejected tool call');
  }
}

export async function dispatchTool(name: string, ctx: ToolContext, args: JsonObject): Promise<ToolResult> {
  const tool = CHAT_TOOLS[name as ChatToolName];
  if (!tool) {
    return fail('UNKNOWN_TOOL', `Unknown tool: ${name}`);
  }

  // Defence in depth: the tool is already absent from the specs sent to the
  // model, but a hallucinated or injected call must not execute either.
  if (isToolWithheld(name)) {
    return fail(
      'TOOL_REQUIRES_APPROVAL',
      `${name} changes access permissions and cannot be performed by the assistant. Ask the user to do it directly.`,
    );
  }

  // PAT scopes propagate into tools: a token may only run tools its scopes
  // would allow over REST. Workspace binding is enforced by the policy
  // helpers the tool handlers call, through the same bound principal.
  const principal = principalFor(ctx.userId);
  if (principal?.authSource === 'pat') {
    const required = tool.effect === 'read' ? ['read'] : ['write'];
    if (!hasRequiredScopes(principal.scopes, required)) {
      return fail('INSUFFICIENT_SCOPE', `Personal access token lacks the ${required[0]} scope required by ${name}`);
    }
  }

  // Replay protection is keyed by our own per-turn identity. A provider may
  // reuse tool-call ids across turns; keying by its id alone answered a new
  // call with an old call's cached result.
  const journalKey = ctx.journalKey ?? ctx.toolCallId;
  const existing = await findExistingResult(ctx.sessionId, journalKey);
  if (existing) return existing;

  // An already-aborted call is journaled but never starts its handler.
  const abortedBeforeStart = ctx.abortSignal?.aborted ? interruptionFor(ctx.abortSignal) : null;
  try {
    await prisma.chatToolCall.create({
      data: {
        sessionId: ctx.sessionId,
        messageId: ctx.messageId ?? undefined,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId ?? undefined,
        toolCallId: journalKey,
        providerToolCallId: ctx.journalKey ? ctx.toolCallId : null,
        turnId: ctx.turnId ?? null,
        toolName: tool.name,
        effect: tool.effect,
        input: toJsonInput(args),
        status: abortedBeforeStart ? 'cancelled' : 'running',
        ...(abortedBeforeStart
          ? { endedAt: new Date(), latencyMs: 0, errorCode: abortedBeforeStart.code, errorMessage: abortedBeforeStart.message }
          : {}),
      },
    });
  } catch (error) {
    if (isPrismaKnownError(error) && error.code === 'P2002') {
      const replay = await findExistingResult(ctx.sessionId, journalKey);
      if (replay) return replay;
    }
    throw error;
  }
  if (abortedBeforeStart) return errorToToolResult(abortedBeforeStart);

  const startedAt = Date.now();
  const execution = runTool(tool, ctx, args);
  try {
    const result = await withTimeout(execution, toolTimeoutMs(), ctx.abortSignal);
    await finishJournal(ctx.sessionId, journalKey, result, result.ok ? 'succeeded' : 'failed', startedAt);
    return result;
  } catch (error) {
    if (error instanceof ToolInterruptedError && tool.effect !== 'read') {
      // The handler started and may still commit: never report a plain failure.
      const result = fail(
        'TOOL_OUTCOME_UNKNOWN',
        'The tool was interrupted after it started, so the change may or may not have been applied. Re-read the affected records before trying again.',
        { cause: error.code },
      );
      await finishJournal(ctx.sessionId, journalKey, result, error.code === 'TOOL_TIMEOUT' ? 'failed' : 'cancelled', startedAt);
      reconcileLateOutcome(execution, ctx, tool, journalKey, startedAt, error.code);
      return result;
    }
    const result = errorToToolResult(error);
    const cancelled = result.code === 'CLIENT_ABORTED' || result.code === 'TURN_TIMEOUT' || result.code === 'TURN_LEASE_LOST';
    await finishJournal(ctx.sessionId, journalKey, result, cancelled ? 'cancelled' : 'failed', startedAt);
    return result;
  }
}
