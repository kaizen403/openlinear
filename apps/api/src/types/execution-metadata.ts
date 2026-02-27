import { z } from 'zod';

/**
 * Execution metadata sync contract
 * 
 * Only these fields are allowed to sync from desktop to cloud.
 * Any additional fields will be rejected at the API boundary.
 * 
 * @see docs/security/trust-boundary.md
 */

// Allowed error categories for execution failures
export const ErrorCategory = z.enum([
  'AUTH',
  'RATE_LIMIT', 
  'MERGE_CONFLICT',
  'TIMEOUT',
  'UNKNOWN'
]);

// Allowed execution statuses
export const ExecutionStatus = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
]);

/**
 * Strict allowlist schema for execution metadata sync
 * 
 * Any field not explicitly listed here will cause validation to fail.
 * This prevents accidental leakage of sensitive data like prompts,
 * tool logs, or local file paths.
 */
export const ExecutionMetadataSyncSchema = z.object({
  // Identifiers
  taskId: z.string(),
  runId: z.string(),
  
  // State
  status: ExecutionStatus,
  
  // Timing
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().min(0).optional(),
  
  // Progress
  progress: z.number().int().min(0).max(100).optional(),
  
  // Git/PR references
  branch: z.string().optional(),
  commitSha: z.string().optional(),
  prUrl: z.string().url().optional(),
  prNumber: z.number().int().positive().optional(),
  
  // Summary
  outcome: z.string().max(500).optional(),
  errorCategory: ErrorCategory.optional(),
  
  // Metrics
  filesChanged: z.number().int().min(0).optional(),
  toolsExecuted: z.number().int().min(0).optional(),
}).strict(); // .strict() rejects unknown keys

/**
 * TypeScript type derived from schema
 */
export type ExecutionMetadataSync = z.infer<typeof ExecutionMetadataSyncSchema>;

/**
 * Validate a sync payload against the allowlist
 * 
 * @param payload - The payload to validate
 * @returns Parsed data if valid, throws ZodError if invalid
 * @throws z.ZodError if payload contains forbidden fields or invalid values
 * 
 * @example
 * ```typescript
 * try {
 *   const valid = validateExecutionMetadataSync({
 *     taskId: 'tsk_123',
 *     runId: 'run_456',
 *     status: 'completed',
 *     durationMs: 45000
 *   });
 *   // valid is typed as ExecutionMetadataSync
 * } catch (err) {
 *   if (err instanceof z.ZodError) {
 *     // Handle validation error - payload contained forbidden fields
 *   }
 * }
 * ```
 */
export function validateExecutionMetadataSync(payload: unknown): ExecutionMetadataSync {
  return ExecutionMetadataSyncSchema.parse(payload);
}

/**
 * Safe validation that returns result instead of throwing
 * 
 * @param payload - The payload to validate  
 * @returns Object with success flag and either data or error
 */
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

/**
 * Check if a payload would be rejected (for testing/logging)
 * 
 * @param payload - The payload to check
 * @returns Object with valid flag and list of issues if invalid
 */
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

/**
 * List of forbidden fields that will cause rejection
 * Used for documentation and testing
 */
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

/**
 * Middleware factory for Express routes
 * 
 * @example
 * ```typescript
 * app.post('/api/execution/sync', validateExecutionMetadataMiddleware(), handler);
 * ```
 */
export function validateExecutionMetadataMiddleware() {
  return (req: any, res: any, next: any) => {
    const result = safeValidateExecutionMetadataSync(req.body);
    
    if (!result.success) {
      // Check if error is due to unrecognized keys (forbidden fields)
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
    
    // Attach validated data to request
    req.validatedMetadata = result.data;
    next();
  };
}
