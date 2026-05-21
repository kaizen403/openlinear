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
  toolCallId: string;
  messageId?: string | null;
  abortSignal?: AbortSignal;
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

export interface ChatTool {
  name: ChatToolName;
  description: string;
  parameters: JsonSchema;
  mutating: boolean;
  handler: (ctx: ToolContext, args: JsonObject) => Promise<ToolResult>;
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
