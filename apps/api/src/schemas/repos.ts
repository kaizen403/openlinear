import { z } from 'zod';
import { gitHttpsUrlSchema, gitRefSchema } from './git';

export const repoUrlBodySchema = z.object({
  url: z.string().min(1, 'URL is required').url('Must be a valid URL'),
});

export const importRepoBodySchema = z.object({
  repo: z.object({
    id: z.union([z.number(), z.string()]),
    full_name: z.string().min(1),
    name: z.string().optional(),
    clone_url: gitHttpsUrlSchema.optional(),
    html_url: z.string().optional(),
    default_branch: gitRefSchema.optional(),
    private: z.boolean().optional(),
    owner: z
      .object({
        login: z.string().optional(),
      })
      .partial()
      .optional(),
  }).passthrough(),
});

export const updateBaseBranchBodySchema = z.object({
  baseBranch: gitRefSchema,
});

export type RepoUrlBody = z.infer<typeof repoUrlBodySchema>;
export type ImportRepoBody = z.infer<typeof importRepoBodySchema>;
export type UpdateBaseBranchBody = z.infer<typeof updateBaseBranchBodySchema>;
