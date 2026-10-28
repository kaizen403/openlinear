import {
  isRecord,
  OpenLinearApiError,
  OpenLinearNetworkError,
  OpenLinearResponseError,
} from '../openlinear/errors';

/** A semantic argument error found by a tool after schema validation. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface FailureContext {
  tool: string;
  /** PAT scopes the tool needs (apps/api/src/registry.ts). */
  scopes: readonly string[];
  /** Repeating the call with identical arguments cannot duplicate or corrupt data. */
  safeToRetry: boolean;
}

export interface ToolFailure {
  /** Short machine code, also sent to `POST /api/mcp/log`. */
  code: string;
  /** Actionable message for the model. */
  message: string;
}

function detailsOf(error: OpenLinearApiError): Record<string, unknown> {
  return isRecord(error.details) ? error.details : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `zod.flatten()` output used by the API's VALIDATION_ERROR details. */
function validationSummary(details: Record<string, unknown>): string {
  const parts: string[] = [];
  const formErrors = details.formErrors;
  if (Array.isArray(formErrors)) {
    for (const message of formErrors) if (typeof message === 'string') parts.push(message);
  }
  const fieldErrors = details.fieldErrors;
  if (isRecord(fieldErrors)) {
    for (const [field, messages] of Object.entries(fieldErrors)) {
      if (Array.isArray(messages)) {
        const first = messages.find((message) => typeof message === 'string');
        if (typeof first === 'string') parts.push(`${field}: ${first}`);
      }
    }
  }
  return parts.length > 0 ? ` (${parts.slice(0, 6).join('; ')})` : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

/** `details.teams[].reason` of 409 TEAM_PROJECT_CONFLICT (apps/api/src/services/projects.ts). */
const TEAM_MOVE_REASONS: Record<string, string> = {
  OTHER_WORKSPACE: 'is in another workspace than the project',
  LAST_TEAM_OF_PROJECT: 'is the only team of its current project, which needs one',
  TEAM_HAS_PROJECT_TASKS: 'still has issues in its current project',
  TEAM_KEY_TAKEN: 'has a key another team of the project already uses',
};

function teamConflicts(details: Record<string, unknown>): string[] {
  const teams = Array.isArray(details.teams) ? details.teams : [];
  return teams.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const teamId = text(entry.teamId) ?? 'unknown team';
    const reason = text(entry.reason);
    return [`team ${teamId} ${(reason && TEAM_MOVE_REASONS[reason]) ?? 'cannot move'}${reason ? ` (${reason})` : ''}`];
  });
}

/** 400 codes with a specific remedy; everything else gets the generic validation message. */
function describeBadRequest(error: OpenLinearApiError, details: Record<string, unknown>, context: FailureContext): string | undefined {
  switch (error.code) {
    case 'INVALID_CURSOR':
      return `The cursor is not a valid pagination token (INVALID_CURSOR): pass back nextCursor exactly as returned, with the same filters. Call ${context.tool} again without cursor to restart from the first page.`;
    case 'PAGINATION_CONFLICT':
      return `OpenLinear refused the pagination arguments (PAGINATION_CONFLICT): ${error.apiMessage ?? 'cursor cannot be combined with page'}. Page with cursor/nextCursor only.`;
    case 'TASK_IDS_REQUIRED':
      return `OpenLinear needs an explicit selection (TASK_IDS_REQUIRED): list the issues to change in taskIds (1-100 issue UUIDs, e.g. from openlinear_list_issues).`;
    case 'BULK_SCOPE_INVALID':
      return `OpenLinear refused the bulk scope (BULK_SCOPE_INVALID): pass exactly one of projectId (issues of that project) or teamId (that team's issues without a project).`;
    case 'LABEL_NOT_IN_TASK_PROJECT': {
      const labelId = text(details.labelId);
      const taskId = text(details.taskId);
      const hasProject = text(details.taskProjectId) !== undefined;
      return `${labelId ? `Label ${labelId}` : 'The label'} cannot be attached to ${taskId ? `issue ${taskId}` : 'this issue'} (LABEL_NOT_IN_TASK_PROJECT): ${
        hasProject || details.taskProjectId === undefined
          ? "labels must belong to the issue's project. Use a label of that project (openlinear_list_labels) or create one there (openlinear_create_label / openlinear_create_phase)."
          : 'the issue has no project, and issues without a project take no labels.'
      } Labels added before it in the same call stay attached and nothing was removed; calling ${context.tool} again skips what is already done.`;
    }
    default:
      return undefined;
  }
}

function retryHint(context: FailureContext): string {
  return context.safeToRetry
    ? `Calling ${context.tool} again with identical arguments is safe.`
    : `The change may or may not have been applied: check the current state before calling ${context.tool} again.`;
}

function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (OpenLinear request id ${requestId})` : message;
}

function describeApiError(error: OpenLinearApiError, context: FailureContext): ToolFailure {
  const details = detailsOf(error);
  const code = error.code ?? `HTTP_${error.status}`;
  const apiMessage = error.apiMessage ?? 'no message';
  const resource = [text(details.resourceType), text(details.resourceId)].filter(Boolean).join(' ');

  switch (error.status) {
    case 400:
      return {
        code,
        message:
          describeBadRequest(error, details, context) ??
          `OpenLinear rejected the request as invalid (${code}): ${apiMessage}${validationSummary(details)}. Fix the arguments and call ${context.tool} again.`,
      };
    case 401:
      return {
        code: 'UNAUTHORIZED',
        message:
          'OpenLinear rejected the personal access token (invalid, expired or revoked). Create a new token in OpenLinear → Settings → Personal Access Tokens and update the Authorization header in the MCP client configuration.',
      };
    case 403: {
      if (error.code === 'INSUFFICIENT_SCOPE') {
        const required = strings(details.requiredScopes);
        return {
          code,
          message: `The personal access token lacks the scope ${context.tool} needs (${context.scopes.join(' or ')})${
            required.length > 0 ? `; this step asked for ${required.join(' + ')}` : ''
          }. Create a token with that scope in OpenLinear → Settings → Personal Access Tokens.`,
        };
      }
      if (error.code === 'PAT_WORKSPACE_RESTRICTED') {
        const bound = text(details.workspaceId);
        return {
          code,
          message: `This personal access token is bound to a single workspace${bound ? ` (${bound})` : ''} and cannot act outside it (PAT_WORKSPACE_RESTRICTED). Use projects, teams and issues from that workspace (openlinear_list_workspaces shows it), or use an account-wide token.`,
        };
      }
      if (error.code === 'SESSION_REQUIRED') {
        return {
          code,
          message: 'This action needs an interactive OpenLinear session and is not available to personal access tokens.',
        };
      }
      const roles = Array.isArray(details.requiredRoles)
        ? details.requiredRoles.filter((role): role is string => typeof role === 'string')
        : [];
      return {
        code,
        message: withRequestId(
          `Access denied${resource ? ` to ${resource}` : ''} (${code}): the token's user lacks ${
            roles.length > 0 ? `the ${roles.join('/')} role` : 'permission'
          }, the project denies access, or the token is bound to another workspace.`,
          error.requestId,
        ),
      };
    }
    case 404:
      return {
        code,
        message: `Not found${resource ? `: ${resource}` : ''}. It does not exist or is not visible to this token; look the id up with a list or search tool (openlinear_list_projects, openlinear_list_issues, openlinear_search).`,
      };
    case 409: {
      if (error.code === 'IDEMPOTENCY_CONFLICT') {
        return {
          code,
          message: `OpenLinear already used this idempotency key for different arguments. Call ${context.tool} with exactly the original arguments to get the original result, or pass a new idempotencyKey to create a new item.`,
        };
      }
      if (error.code === 'IDEMPOTENCY_IN_PROGRESS') {
        return {
          code,
          message: `An identical ${context.tool} request is still being processed by OpenLinear. Wait a few seconds and call it again with the same arguments: you will get the original result, not a duplicate.`,
        };
      }
      if (error.code === 'TEAM_PROJECT_CONFLICT') {
        const conflicts = teamConflicts(details);
        return {
          code,
          message:
            conflicts.length > 0
              ? `OpenLinear cannot move the team into the project (TEAM_PROJECT_CONFLICT): ${conflicts.join('; ')}. Nothing was created. Omit teamId/teamIds to give the project its own default team, or pick a team that can move (same workspace, not the last team of its project, no issues there).`
              : 'OpenLinear rejected the team id (TEAM_PROJECT_CONFLICT): the team cannot move into this project. Nothing was created. Omit teamId/teamIds; every new project gets its own default team.',
        };
      }
      if (error.code === 'P2002') {
        const target = Array.isArray(details.target) ? details.target.filter((field) => typeof field === 'string') : [];
        return {
          code,
          message: `Conflicts with an existing record${target.length > 0 ? ` (unique ${target.join(', ')})` : ''}: a project key, team key or label name that must be unique already exists. Reuse the existing one or choose a different value.`,
        };
      }
      return { code, message: withRequestId(`Conflict (${code}): ${apiMessage}.`, error.requestId) };
    }
    case 413:
      return {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'The request is too large for the OpenLinear API (256 KB per request). Send fewer or shorter items per call.',
      };
    case 422:
      return {
        code,
        message:
          error.code === 'IDEMPOTENCY_RESPONSE_TOO_LARGE'
            ? 'The result is too large for OpenLinear to keep for safe retries, so nothing was written. Split the work into smaller calls.'
            : `OpenLinear could not process the request (${code}): ${apiMessage}.`,
      };
    case 429: {
      const scope = text(details.scope);
      const wait = error.retryAfterSeconds ?? 60;
      // apps/api/src/middleware/rate-limit.ts: `principal` = this token's own budget,
      // `default` = the per-IP budget for requests the API could not attribute to a token yet.
      const budget =
        scope === 'principal'
          ? ' for this personal access token (principal: every client using the token shares one budget)'
          : scope === 'default'
            ? ' for this network address (default)'
            : scope
              ? ` (${scope})`
              : '';
      return {
        code: 'RATE_LIMITED',
        message: `OpenLinear rate limit reached${budget}. Wait ${wait} seconds before calling ${context.tool} again.`,
      };
    }
    default:
      if (error.status >= 500) {
        return {
          code,
          message: withRequestId(`OpenLinear API error ${error.status} (${code}). ${retryHint(context)}`, error.requestId),
        };
      }
      return { code, message: withRequestId(`OpenLinear API error ${error.status} (${code}): ${apiMessage}.`, error.requestId) };
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Map any failure inside a tool to a short code and an actionable message. Never exposes stack traces. */
export function describeFailure(error: unknown, context: FailureContext): ToolFailure {
  if (error instanceof ToolInputError) return { code: 'INVALID_ARGUMENTS', message: error.message };
  if (error instanceof OpenLinearApiError) return describeApiError(error, context);
  if (error instanceof OpenLinearNetworkError) {
    return {
      code: error.reason === 'timeout' ? 'API_TIMEOUT' : 'API_UNREACHABLE',
      message: `${error.reason === 'timeout' ? 'The OpenLinear API did not answer in time' : 'Could not reach the OpenLinear API'}. ${retryHint(context)}`,
    };
  }
  if (error instanceof OpenLinearResponseError) {
    return {
      code: 'UNEXPECTED_RESPONSE',
      message: `${error.message}. ${retryHint(context)}`,
    };
  }
  if (isAbort(error)) return { code: 'CANCELLED', message: 'The request was cancelled.' };
  return { code: 'INTERNAL', message: `Unexpected error in the OpenLinear MCP server. ${retryHint(context)}` };
}
