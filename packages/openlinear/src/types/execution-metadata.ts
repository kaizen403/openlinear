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

export function validateExecutionMetadataMiddleware() {
  return (req: any, res: any, next: any) => {
    const result = safeValidateExecutionMetadataSync(req.body);
    
    if (!result.success) {
      const hasUnknownKeys = result.error.errors.some(e => 
        e.message.includes('Unrecognized key') || 
        e.code === 'unrecognized_keys'
      );
      
      return res.status(400).json({
        error: 'Invalid sync payload',
        code: hasUnknownKeys ? 'FORBIDDEN_FIELDS' : 'VALIDATION_ERROR',
        details: result.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message
        }))
      });
    }
    
    req.validatedMetadata = result.data;
    next();
  };
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
