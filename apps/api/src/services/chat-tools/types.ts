import { type Prisma } from '@openlinear/db';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export type ChatToolName =
  | 'list_workspaces'
  | 'get_workspace'
  | 'list_workspace_members'
  | 'list_projects'
  | 'get_project'
  | 'list_project_access'
  | 'list_teams'
  | 'get_team'
  | 'list_team_members'
  | 'list_issues'
  | 'get_issue'
  | 'list_comments'
  | 'list_labels'
  | 'search'
  | 'create_issue'
  | 'update_issue'
  | 'move_issue'
  | 'bulk_update_issues'
  | 'archive_issues'
  | 'comment_on_issue'
  | 'bulk_create_issues'
  | 'setup_project_plan'
  | 'propose_plan'
  | 'list_plans'
  | 'get_plan'
  | 'revise_plan'
  | 'list_knowledge'
  | 'propose_knowledge'
  | 'create_label'
  | 'update_label'
  | 'create_project'
  | 'update_project'
  | 'grant_project_access'
  | 'create_team'
  | 'update_team'
  | 'invite_workspace_member'
  | 'invite_team_member'
  | 'change_workspace_member_role'
  | 'change_team_member_role'
  | 'update_workspace';

export interface ToolContext {
  userId: string;
  sessionId: string;
  workspaceId: string;
  projectId?: string | null;
  /** Provider-visible tool-call id (transcript, SSE). Not trusted for dedupe. */
  toolCallId: string;
  /**
   * Journal identity assigned by the server (`<turnId>:<round>:<index>` for
   * chat turns). Replayed results are looked up by this key, never by the
   * provider id alone, which a provider may reuse across turns. Direct callers
   * without a turn fall back to `toolCallId`.
   */
  journalKey?: string;
  turnId?: string;
  messageId?: string | null;
  abortSignal?: AbortSignal;
  /**
   * Confirmation codes present in the authenticated user's own message for
   * this turn (typed text or the structured `confirmationTokens` field). A
   * destructive tool can only redeem a code that appears here.
   */
  userConfirmations?: ReadonlySet<string>;
  /**
   * Called when a write that was interrupted after it started (reported as
   * `TOOL_OUTCOME_UNKNOWN`) settles and its real outcome is journaled. The
   * chat turn forwards it to its stream while the stream is still open.
   */
  onReconciled?: (reconciliation: ToolReconciliation) => void;
}

/** The real outcome of an interrupted write, recorded after it settled. */
export interface ToolReconciliation {
  /** Provider-visible tool-call id (transcript, SSE). */
  toolCallId: string;
  journalKey: string;
  sessionId: string;
  messageId: string | null;
  toolName: string;
  effect: ToolEffect;
  status: 'succeeded' | 'failed';
  result: ToolResult;
  /** What interrupted the call (`TOOL_TIMEOUT`, `CLIENT_ABORTED`, `TURN_TIMEOUT`, `TURN_LEASE_LOST`). */
  reconciledAfter: string;
  reconciledAt: string;
}

export interface ToolResult {
  ok: boolean;
  code: string;
  message: string;
  data?: unknown;
  details?: unknown;
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  additionalProperties?: boolean;
  default?: JsonValue;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

/**
 * What a tool does to the world, which decides how it is dispatched:
 *  - `read`: no state change; allowed (PAT `read` scope).
 *  - `write`: ordinary caller-authorised change; allowed and journaled
 *    (PAT `write` scope).
 *  - `destructive`: broad or hard-to-reverse change (bulk status rewrite,
 *    archive, access/role changes). Never runs on the first call: it returns a
 *    preview and a server-issued confirmation code the user must send back.
 *  - `external`: an effect outside OpenLinear's database (messages, publishing).
 *    Gated exactly like `destructive`. No chat tool has this effect today.
 */
export type ToolEffect = 'read' | 'write' | 'destructive' | 'external';

export const TOOL_EFFECTS: readonly ToolEffect[] = ['read', 'write', 'destructive', 'external'];

/** The exact change a confirmation code is bound to. */
export interface ConfirmationBinding {
  toolName: ChatToolName;
  projectId: string | null;
  /** Canonical description of the change (e.g. `{ status: 'done' }`). */
  change: JsonObject;
  /** Exact targets with a revision, so any concurrent edit invalidates the code. */
  targets: Array<{ id: string; revision: string }>;
}

/** Result of resolving a destructive call read-only. */
export type PreparedAction =
  | { kind: 'result'; result: ToolResult }
  | {
      kind: 'action';
      binding: ConfirmationBinding;
      /** One line for the user, e.g. "Set status to done on 12 issues". */
      summary: string;
      /** Exact selection shown to the user before confirming. */
      preview: JsonObject;
      /** Performs the change on exactly the bound targets. */
      execute: () => Promise<ToolResult>;
    };

interface ChatToolBase {
  name: ChatToolName;
  description: string;
  parameters: JsonSchema;
}

export interface DirectChatTool extends ChatToolBase {
  effect: 'read' | 'write';
  handler: (ctx: ToolContext, args: JsonObject) => Promise<ToolResult>;
}

export interface ConfirmedChatTool extends ChatToolBase {
  effect: 'destructive' | 'external';
  /** Resolve the exact selection without changing anything. */
  prepare: (ctx: ToolContext, args: JsonObject) => Promise<PreparedAction>;
}

export type ChatTool = DirectChatTool | ConfirmedChatTool;

export function requiresConfirmation(tool: ChatTool): tool is ConfirmedChatTool {
  return tool.effect === 'destructive' || tool.effect === 'external';
}

export function ok(message: string, data?: unknown): ToolResult {
  return { ok: true, code: 'OK', message, ...(data !== undefined ? { data } : {}) };
}

export function fail(code: string, message: string, details?: unknown): ToolResult {
  return { ok: false, code, message, ...(details !== undefined ? { details } : {}) };
}

export function toJsonInput(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

export function boolArg(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function numberArg(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === 'number' ? value : undefined;
}

export function stringArrayArg(args: JsonObject, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}

export function objectArrayArg(args: JsonObject, key: string): JsonObject[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord);
}

export const emptyParameters: JsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export function objectParameters(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

/** Abort reason used when a chat turn exceeds its time budget. */
export class ChatTurnDeadlineError extends Error {
  readonly code = 'TURN_TIMEOUT' as const;

  constructor() {
    super('The chat turn exceeded its time limit');
    this.name = 'ChatTurnDeadlineError';
  }
}

/**
 * Error code for work interrupted by `signal`: the turn deadline, the turn
 * losing its session lease, or the client going away.
 */
export function abortCodeFor(signal?: AbortSignal): 'TURN_TIMEOUT' | 'TURN_LEASE_LOST' | 'CLIENT_ABORTED' {
  if (signal?.reason instanceof ChatTurnDeadlineError) return 'TURN_TIMEOUT';
  const reason: unknown = signal?.reason;
  if (reason instanceof Error && (reason as { code?: unknown }).code === 'TURN_LEASE_LOST') return 'TURN_LEASE_LOST';
  return 'CLIENT_ABORTED';
}
