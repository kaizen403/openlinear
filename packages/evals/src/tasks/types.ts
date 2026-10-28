import { z } from 'zod';
import { GitShaSchema, Sha256Schema } from '../manifest/schema';

/**
 * Private product holdout format (PRD §10 layer 3).
 *
 *   <holdout>/holdout.json                 index: id, split policy, frozen date, task checksums
 *   <holdout>/tasks/<id>/task.json         metadata + verifier contract (this schema)
 *   <holdout>/tasks/<id>/instruction.md    the only agent-facing text
 *   <holdout>/tasks/<id>/repo/             seed repository (kind "inline"); or a pinned git URL + base SHA
 *   <holdout>/tasks/<id>/grader/           hidden tests/assets — never copied into the agent's worktree
 *   <holdout>/tasks/<id>/reference.patch   reference solution (must pass); the empty patch must fail
 *
 * The verifier runs in a pristine checkout of the base commit with the
 * produced patch applied and the grader assets copied over it.
 */

export const TASK_SCHEMA_VERSION = 'openlinear.eval.task/v1' as const;
export const HOLDOUT_SCHEMA_VERSION = 'openlinear.eval.holdout/v1' as const;

const RelativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\0'), 'must be a relative path inside the task');

export const VerifierSpecSchema = z
  .object({
    /** argv run in the pristine checkout (no shell). */
    command: z.array(z.string().min(1)).min(1),
    timeoutMs: z.number().int().positive(),
    /** Grader asset directory inside the task (outside the agent's worktree). */
    graderDir: RelativePath.default('grader'),
    /** Where the grader assets are copied in the pristine checkout ('.' = repository root). */
    copyInto: z.string().default('.'),
    /** Test identifiers that must go from failing to passing / keep passing (informational for custom verifiers). */
    failToPass: z.array(z.string()).default([]),
    passToPass: z.array(z.string()).default([]),
  })
  .strict();

export const TaskSpecSchema = z
  .object({
    schemaVersion: z.literal(TASK_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    title: z.string().min(1),
    category: z.string().min(1),
    /** Bootstrap cluster, e.g. the source repository. */
    cluster: z.string().min(1),
    split: z.enum(['development', 'validation', 'sealed']),
    createdAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    author: z.string().min(1),
    instructionFile: RelativePath.default('instruction.md'),
    repo: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('inline'), dir: RelativePath.default('repo') }).strict(),
      z.object({ kind: z.literal('git'), url: z.string().min(1), baseSha: GitShaSchema }).strict(),
    ]),
    verifier: VerifierSpecSchema,
    /** Path prefixes the agent must not modify (a patch touching them is a safety outcome). */
    protectedPaths: z.array(z.string().min(1)).default([]),
    referencePatch: RelativePath.nullable().default('reference.patch'),
    tags: z.array(z.string()).default([]),
  })
  .strict();

export const HoldoutIndexSchema = z
  .object({
    schemaVersion: z.literal(HOLDOUT_SCHEMA_VERSION),
    id: z.string().min(1),
    description: z.string().default(''),
    /** Set when the task set is frozen; tasks may not change afterwards (checksums enforce it). */
    frozenAt: z.string().nullable().default(null),
    tasks: z.array(z.object({ id: z.string().min(1), checksum: Sha256Schema.nullable().default(null) }).strict()).min(1),
  })
  .strict();

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type HoldoutIndex = z.infer<typeof HoldoutIndexSchema>;
export type VerifierSpec = z.infer<typeof VerifierSpecSchema>;

/** A task loaded from disk with its resolved locations and checksum. */
export interface LoadedTask {
  spec: TaskSpec;
  /** Absolute task directory. */
  dir: string;
  instruction: string;
  /** Absolute grader directory (outside any agent worktree). */
  graderDir: string;
  referencePatch: string | null;
  checksum: string;
  sealed: boolean;
}
