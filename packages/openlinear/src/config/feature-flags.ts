import { z } from 'zod';

export const FeatureFlagsSchema = z.object({
  LOCAL_EXECUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SERVER_EXECUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CANARY_PERCENTAGE: z
    .string()
    .default('0')
    .transform((v) => parseInt(v, 10))
    .refine((v) => v >= 0 && v <= 100, {
      message: 'CANARY_PERCENTAGE must be between 0 and 100',
    }),
  FORCE_LOCAL_EXECUTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  KILL_SWITCH_LOCAL_EXECUTION: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

export function parseFeatureFlags(env: Record<string, string | undefined> = process.env): FeatureFlags {
  return FeatureFlagsSchema.parse(env);
}

export function getFeatureFlags(): FeatureFlags {
  return parseFeatureFlags();
}

export function isLocalExecutionEnabled(userId: string, flags: FeatureFlags = getFeatureFlags()): boolean {
  if (flags.KILL_SWITCH_LOCAL_EXECUTION) {
    return false;
  }

  if (flags.FORCE_LOCAL_EXECUTION) {
    return true;
  }

  if (!flags.LOCAL_EXECUTION_ENABLED) {
    return false;
  }

  if (flags.CANARY_PERCENTAGE >= 100) {
    return true;
  }

  if (flags.CANARY_PERCENTAGE <= 0) {
    return false;
  }

  const hash = hashString(userId);
  const userPercentage = (hash % 100) + 1;

  return userPercentage <= flags.CANARY_PERCENTAGE;
}

export function isServerExecutionEnabled(flags: FeatureFlags = getFeatureFlags()): boolean {
  return flags.SERVER_EXECUTION_ENABLED;
}

export function validateFlagConfiguration(flags: FeatureFlags): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (flags.FORCE_LOCAL_EXECUTION && flags.KILL_SWITCH_LOCAL_EXECUTION) {
    errors.push('Cannot enable both FORCE_LOCAL_EXECUTION and KILL_SWITCH_LOCAL_EXECUTION');
  }

  if (!flags.LOCAL_EXECUTION_ENABLED && !flags.SERVER_EXECUTION_ENABLED) {
    errors.push('At least one execution mode must be enabled');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

export function getMigrationPhase(flags: FeatureFlags = getFeatureFlags()): 
  | 'shadow'
  | 'canary'
  | 'cutover'
  | 'rollback'
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
