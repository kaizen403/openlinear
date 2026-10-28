import * as z from 'zod';

/*
 * Input building blocks. Ids use the lenient 8-4-4-4-12 hex pattern
 * (`z.guid()`), the same check the API's zod 3 `.uuid()` applies, so the MCP
 * never rejects an id the API accepts.
 */

export const id = (what: string) => z.guid().describe(`${what} UUID`);

export const IssueStatus = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
export const IssuePriority = z.enum(['low', 'medium', 'high']);
/** FE-02: the agent runners the execution engine knows (the API refuses anything else). */
export const AgentRunner = z.enum(['opencode', 'claude-code', 'codex']);
export const ProjectStatus = z.enum(['planned', 'in_progress', 'paused', 'completed', 'cancelled']);

export const HexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .describe('Hex colour, e.g. #3B82F6');

/** ISO 8601 UTC timestamp, the format the API accepts (`2026-11-01T00:00:00Z`). */
export const DueDate = z.iso.datetime().describe('ISO 8601 UTC timestamp, e.g. 2026-11-01T00:00:00Z');

export const WorkspaceId = z
  .string()
  .min(1)
  .max(200)
  .describe('Workspace id from openlinear_list_workspaces');

export const ProjectKey = z
  .string()
  .trim()
  .min(2)
  .max(12)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/)
  .describe('2-12 letters/digits starting with a letter; stored uppercase');

export const IdempotencyKeyArg = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'Optional. Identical calls are already de-duplicated; pass a new value only to deliberately create another identical item.',
  );
