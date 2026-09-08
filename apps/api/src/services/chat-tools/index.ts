import { Prisma, prisma } from '@openlinear/db';
import { HttpError, isHttpError, isValidationError } from '../../errors';
import { isOwnershipError } from '../ownership';
import { CHAT_DOMAIN_TOOLS, assertNoToolShapeDrift } from './domain';
import { fail, isRecord, toJsonInput, type ChatTool, type ChatToolName, type JsonObject, type ToolContext, type ToolResult } from './types';

const TOOL_TIMEOUT_MS = 30000;

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
 * an access control.
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

export function getOpenAIFunctionSpecs() {
  return CHAT_DOMAIN_TOOLS.filter((tool) => !isToolWithheld(tool.name)).map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
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

function errorToToolResult(error: unknown): ToolResult {
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new HttpError(499, 'CLIENT_ABORTED', 'Chat request was aborted'));
      return;
    }
    const timeout = setTimeout(() => reject(new HttpError(504, 'TOOL_TIMEOUT', 'Tool timed out')), timeoutMs);
    timeout.unref?.();
    const onAbort = () => reject(new HttpError(499, 'CLIENT_ABORTED', 'Chat request was aborted'));
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

async function findExistingResult(ctx: ToolContext): Promise<ToolResult | null> {
  const existing = await prisma.chatToolCall.findUnique({
    where: { sessionId_toolCallId: { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId } },
    select: { status: true, output: true, errorCode: true, errorMessage: true },
  });
  if (!existing) return null;
  if (existing.status === 'succeeded' && existing.output !== null) return coerceToolResult(existing.output);
  if (existing.status === 'failed') return fail(existing.errorCode ?? 'TOOL_ERROR', existing.errorMessage ?? 'Tool failed');
  if (existing.status === 'cancelled') return fail('CLIENT_ABORTED', 'Previous matching tool call was cancelled');
  return fail('TOOL_CALL_IN_PROGRESS', 'A matching tool call is already running');
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

  const existing = await findExistingResult(ctx);
  if (existing) return existing;

  const startedAt = Date.now();
  try {
    await prisma.chatToolCall.create({
      data: {
        sessionId: ctx.sessionId,
        messageId: ctx.messageId ?? undefined,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId ?? undefined,
        toolCallId: ctx.toolCallId,
        toolName: tool.name,
        input: toJsonInput(args),
        status: 'running',
      },
    });
  } catch (error) {
    if (isPrismaKnownError(error) && error.code === 'P2002') {
      const replay = await findExistingResult(ctx);
      if (replay) return replay;
    }
    throw error;
  }

  try {
    const result = await withTimeout(tool.handler(ctx, args), TOOL_TIMEOUT_MS, ctx.abortSignal);
    await prisma.chatToolCall.update({
      where: { sessionId_toolCallId: { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId } },
      data: {
        status: result.ok ? 'succeeded' : 'failed',
        output: toJsonInput(result),
        endedAt: new Date(),
        latencyMs: Date.now() - startedAt,
        errorCode: result.ok ? null : result.code,
        errorMessage: result.ok ? null : result.message,
      },
    });
    return result;
  } catch (error) {
    const result = errorToToolResult(error);
    await prisma.chatToolCall.update({
      where: { sessionId_toolCallId: { sessionId: ctx.sessionId, toolCallId: ctx.toolCallId } },
      data: {
        status: result.code === 'CLIENT_ABORTED' ? 'cancelled' : 'failed',
        output: toJsonInput(result),
        endedAt: new Date(),
        latencyMs: Date.now() - startedAt,
        errorCode: result.code,
        errorMessage: result.message,
      },
    });
    return result;
  }
}
