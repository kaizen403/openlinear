import { z } from 'zod';

/**
 * Feature flags for execution mode migration
 * 
 * These flags control the migration from server/container execution
 * to local execution with metadata-only sync.
 * 
 * @see docs/security/trust-boundary.md
 */

const FeatureFlagsSchema = z.object({
  /**
   * Enable local execution mode
   * When true, desktop app runs tasks locally and syncs metadata only
   */
  LOCAL_EXECUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Enable server/container execution mode
   * When true, API can spawn containers and execute tasks server-side
   * This should be disabled after successful migration
   */
  SERVER_EXECUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Canary cohort percentage (0-100)
   * Percentage of users who get local execution by default
   * Used for gradual rollout
   */
  CANARY_PERCENTAGE: z
    .string()
    .default('0')
    .transform((v) => parseInt(v, 10))
    .refine((v) => v >= 0 && v <= 100, {
      message: 'CANARY_PERCENTAGE must be between 0 and 100',
    }),

  /**
   * Force local execution for all users
   * Emergency flag to force local mode regardless of canary
   */
  FORCE_LOCAL_EXECUTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  /**
   * Kill switch for local execution
   * Emergency flag to disable local mode and fall back to server
   */
  KILL_SWITCH_LOCAL_EXECUTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

/**
 * Parse and validate feature flags from environment
 */
export function parseFeatureFlags(env: Record<string, string | undefined> = process.env): FeatureFlags {
  return FeatureFlagsSchema.parse(env);
}

/**
 * Get feature flags with safe defaults (for testing)
 */
export function getFeatureFlags(): FeatureFlags {
  return parseFeatureFlags();
}

/**
 * Check if local execution is enabled for a specific user
 * 
 * @param userId - User identifier for canary cohort calculation
 * @param flags - Feature flags configuration
 * @returns true if local execution should be used
 */
export function isLocalExecutionEnabled(userId: string, flags: FeatureFlags = getFeatureFlags()): boolean {
  // Kill switch takes precedence
  if (flags.KILL_SWITCH_LOCAL_EXECUTION) {
    return false;
  }

  // Force flag takes next precedence
  if (flags.FORCE_LOCAL_EXECUTION) {
    return true;
  }

  // Check if local execution is globally enabled
  if (!flags.LOCAL_EXECUTION_ENABLED) {
    return false;
  }

  // Check canary cohort
  if (flags.CANARY_PERCENTAGE >= 100) {
    return true;
  }

  if (flags.CANARY_PERCENTAGE <= 0) {
    return false;
  }

  // Calculate if user is in canary cohort
  // Use simple hash of userId for deterministic assignment
  const hash = hashString(userId);
  const userPercentage = (hash % 100) + 1; // 1-100

  return userPercentage <= flags.CANARY_PERCENTAGE;
}

/**
 * Check if server execution is available
 * 
 * @param flags - Feature flags configuration
 * @returns true if server execution is enabled
 */
export function isServerExecutionEnabled(flags: FeatureFlags = getFeatureFlags()): boolean {
  return flags.SERVER_EXECUTION_ENABLED;
}

/**
 * Validate flag configuration
 * Ensures flags are not in conflicting state
 */
export function validateFlagConfiguration(flags: FeatureFlags): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Cannot have both force and kill switch enabled
  if (flags.FORCE_LOCAL_EXECUTION && flags.KILL_SWITCH_LOCAL_EXECUTION) {
    errors.push('Cannot enable both FORCE_LOCAL_EXECUTION and KILL_SWITCH_LOCAL_EXECUTION');
  }

  // Warn if local is enabled but server is disabled (cutover mode)
  if (flags.LOCAL_EXECUTION_ENABLED && !flags.SERVER_EXECUTION_ENABLED) {
    // This is valid - it's the final cutover state
  }

  // Warn if neither execution mode is enabled
  if (!flags.LOCAL_EXECUTION_ENABLED && !flags.SERVER_EXECUTION_ENABLED) {
    errors.push('At least one execution mode must be enabled');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Simple string hash for canary cohort assignment
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Get current migration phase based on flags
 */
export function getMigrationPhase(flags: FeatureFlags = getFeatureFlags()): 
  | 'shadow'      // Both modes running, comparing results
  | 'canary'      // Gradual rollout to subset of users
  | 'cutover'     // Local execution default, server disabled
  | 'rollback'    // Rolled back to server execution
  | 'unknown' {
  
  if (flags.KILL_SWITCH_LOCAL_EXECUTION) {
    return 'rollback';
  }

  if (!flags.SERVER_EXECUTION_ENABLED) {
    return 'cutover';
  }

  if (flags.LOCAL_EXECUTION_ENABLED && flags.CANARY_PERCENTAGE > 0) {
    return 'canary';
  }

  if (flags.LOCAL_EXECUTION_ENABLED && flags.CANARY_PERCENTAGE === 0) {
    return 'shadow';
  }

  return 'unknown';
}
