import { z } from 'zod';

export const ErrorCategory = z.enum([
  'AUTH',
  'RATE_LIMIT',
  'MERGE_CONFLICT',
  'TIMEOUT',
  'UNKNOWN'
]);

export const ExecutionStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

export const ExecutionMetadataSyncSchema = z.object({
  taskId: z.string(),
  runId: z.string(),
  status: ExecutionStatus,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().min(0).optional(),
  progress: z.number().int().min(0).max(100).optional(),
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  prUrl: z.string().url().optional(),
  prNumber: z.number().int().positive().optional(),
  outcome: z.string().max(500).optional(),
  errorCategory: ErrorCategory.optional(),
  filesChanged: z.number().int().min(0).optional(),
  toolsExecuted: z.number().int().min(0).optional(),
}).strict();

export type ExecutionMetadataSync = z.infer<typeof ExecutionMetadataSyncSchema>;

export function validateExecutionMetadataSync(payload: unknown): ExecutionMetadataSync {
  return ExecutionMetadataSyncSchema.parse(payload);
}

export function safeValidateExecutionMetadataSync(payload: unknown): 
  | { success: true; data: ExecutionMetadataSync }
  | { success: false; error: z.ZodError } {
  const result = ExecutionMetadataSyncSchema.safeParse(payload);
  
  if (result.success) {
    return { success: true, data: result.data };
  } else {
    return { success: false, error: result.error };
  }
}

export function checkExecutionMetadataSync(payload: unknown): {
  valid: boolean;
  issues?: string[];
} {
  const result = ExecutionMetadataSyncSchema.safeParse(payload);
  
  if (result.success) {
    return { valid: true };
  } else {
    return {
      valid: false,
      issues: result.error.errors.map(e => 
        `${e.path.join('.')}: ${e.message}`
      )
    };
  }
}

export const FORBIDDEN_SYNC_FIELDS = [
  'prompt',
  'logs',
  'toolLogs',
  'executionLogs',
  'repoPath',
  'accessToken',
  'apiKey',
  'passwordHash',
  'jwt',
  'client',
  'timeoutId',
  'rawOutput',
  'diff',
  'fileContents',
  'env',
  'environment',
  'processEnv',
] as const;

export function isForbiddenField(field: string): boolean {
  return FORBIDDEN_SYNC_FIELDS.includes(field as any);
}

export function sanitizePayload(payload: Record<string, any>): {
  sanitized: Record<string, any>;
  removed: string[];
} {
  const sanitized: Record<string, any> = {};
  const removed: string[] = [];
  
  for (const [key, value] of Object.entries(payload)) {
    if (isForbiddenField(key)) {
      removed.push(key);
    } else {
      sanitized[key] = value;
    }
  }
  
  return { sanitized, removed };
}
