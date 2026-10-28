import { z } from 'zod';

/**
 * W19b / FE-13 project knowledge: what the team wants every agent run in a
 * project to know. People write or approve entries; agents only propose.
 */

export const KNOWLEDGE_KINDS = ['note', 'convention', 'procedure'] as const;
export const KNOWLEDGE_STATUSES = ['proposed', 'active', 'retracted'] as const;
export const MAX_KNOWLEDGE_TITLE = 120;
export const MAX_KNOWLEDGE_BODY = 4_000;

const title = z.string().trim().min(1).max(MAX_KNOWLEDGE_TITLE);
const body = z.string().trim().min(1).max(MAX_KNOWLEDGE_BODY);
const id = z.string().trim().min(1).max(200);
const expiresAt = z.string().datetime({ offset: true }).nullable();

/** Where an entry came from (kept with it; a review finding of a sealed task is refused). */
export const knowledgeSourceRefSchema = z.object({
  taskId: id.optional(),
  runId: id.optional(),
  reviewId: id.optional(),
  findingId: id.optional(),
  commit: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
  chatSessionId: id.optional(),
}).strict();

export const createKnowledgeBodySchema = z.object({
  kind: z.enum(KNOWLEDGE_KINDS).default('note'),
  title,
  body,
  expiresAt: expiresAt.optional(),
  sourceRef: knowledgeSourceRefSchema.optional(),
}).strict();

export const updateKnowledgeBodySchema = z.object({
  /** The revision this edit is based on; must be the latest (optimistic concurrency). */
  baseVersion: z.number().int().min(1),
  kind: z.enum(KNOWLEDGE_KINDS).optional(),
  title: title.optional(),
  body: body.optional(),
  expiresAt: expiresAt.optional(),
}).strict().refine((value) => value.kind !== undefined || value.title !== undefined || value.body !== undefined || value.expiresAt !== undefined, 'Nothing to change');

export const approveKnowledgeBodySchema = z.object({
  /** The revision being approved; must still be the latest. */
  version: z.number().int().min(1),
}).strict();

export const retractKnowledgeBodySchema = z.object({
  reason: z.string().trim().min(1).max(500),
}).strict();

export const listKnowledgeQuerySchema = z.object({
  status: z.enum([...KNOWLEDGE_STATUSES, 'all']).default('all'),
}).strict();

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export type KnowledgeSourceRef = z.infer<typeof knowledgeSourceRefSchema>;
export type CreateKnowledgeBody = z.infer<typeof createKnowledgeBodySchema>;
export type UpdateKnowledgeBody = z.infer<typeof updateKnowledgeBodySchema>;
export type ApproveKnowledgeBody = z.infer<typeof approveKnowledgeBodySchema>;
export type RetractKnowledgeBody = z.infer<typeof retractKnowledgeBodySchema>;
export type ListKnowledgeQuery = z.infer<typeof listKnowledgeQuerySchema>;
