import * as z from 'zod';
import type { ApiKnowledgeEntry } from '../../openlinear/api';
import { deriveIdempotencyKey } from '../idempotency';
import { id, IdempotencyKeyArg } from '../inputs';
import { IdempotencyShape } from '../shapes';
import { defineTool, READ_ONLY } from '../tool';

/**
 * W19b project knowledge: conventions, procedures and notes every agent run
 * in a project is given. People write and approve entries in OpenLinear; an
 * MCP client (a personal access token) can only propose them.
 */

const KnowledgeShape = z.object({
  id: z.string().describe('Knowledge entry UUID'),
  kind: z.string().describe('convention | procedure | note'),
  title: z.string(),
  body: z.string(),
  status: z.string().describe('active (given to runs) | proposed (waits for a person) | retracted'),
  expired: z.boolean().describe('Past its expiry: kept, no longer given to runs'),
  version: z.number().int().describe('Latest revision'),
  source: z.string().describe('user | agent | review_finding'),
  updatedAt: z.string(),
});

function toEntry(entry: ApiKnowledgeEntry): z.infer<typeof KnowledgeShape> {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    body: entry.body,
    status: entry.status,
    expired: entry.expired ?? false,
    version: entry.version,
    source: entry.source,
    updatedAt: entry.updatedAt,
  };
}

export const listKnowledge = defineTool({
  name: 'openlinear_list_knowledge',
  title: 'List project knowledge',
  description: "List a project's knowledge: the conventions, procedures and notes the team wrote or approved (every agent run in the project is given the active ones), plus proposals waiting for a person. Read it before working in a project, and before proposing something that already exists.",
  input: z.strictObject({
    projectId: id('Project'),
    includeRetracted: z.boolean().optional().describe('Also list retracted entries (default false)'),
  }),
  output: z.object({ entries: z.array(KnowledgeShape) }),
  annotations: READ_ONLY,
  scopes: ['read', 'tasks:read'],
  async run({ projectId, includeRetracted }, { api, signal }) {
    const entries = await api.listKnowledge(projectId, signal);
    return { entries: entries.filter((entry) => includeRetracted || entry.status !== 'retracted').map(toEntry) };
  },
});

export const proposeKnowledge = defineTool({
  name: 'openlinear_propose_knowledge',
  title: 'Propose project knowledge',
  description:
    'Propose a convention, procedure or note that every future agent run in a project should know (e.g. "Use pnpm, never npm"). It is saved as a proposal: nothing changes for agents until a person approves it in OpenLinear (project → Knowledge). Write a general, lasting rule, not a one-off instruction; use it when the user asks you to remember something. Safe to retry.',
  input: z.strictObject({
    projectId: id('Project'),
    kind: z.enum(['convention', 'procedure', 'note']).optional().describe('convention (a rule the code follows), procedure (steps), note (context); default note'),
    title: z.string().trim().min(1).max(120).describe('Short rule'),
    body: z.string().trim().min(1).max(4000).describe('What agents should know'),
    idempotencyKey: IdempotencyKeyArg.optional(),
  }),
  output: z.object({ entry: KnowledgeShape, idempotency: IdempotencyShape }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: ['write', 'tasks:write'],
  async run(args, { api, signal, toolName }) {
    const key = await deriveIdempotencyKey(toolName, 'knowledge', args);
    const created = await api.proposeKnowledge(args.projectId, { kind: args.kind ?? 'note', title: args.title, body: args.body }, key, signal);
    return { entry: toEntry(created.value), idempotency: { key, replayed: created.replayed } };
  },
});
