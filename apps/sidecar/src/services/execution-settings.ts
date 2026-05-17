import { prisma } from '@openlinear/db';

export interface ExecutionSettings {
  parallelLimit: number;
  maxBatchSize: number;
  queueAutoApprove: boolean;
  stopOnFailure: boolean;
  conflictBehavior: 'skip' | 'fail';
}

const DEFAULTS: ExecutionSettings = {
  parallelLimit: 3,
  maxBatchSize: 3,
  queueAutoApprove: false,
  stopOnFailure: false,
  conflictBehavior: 'skip',
};

/**
 * Load execution settings for a user.
 *
 * Settings are user-scoped (Settings.userId is @unique). Earlier sidecar code
 * looked up `{ id: 'default' }` which always missed and silently used schema
 * defaults — meaning user-configured parallelLimit, queueAutoApprove, etc.
 * were ignored at execution time.
 *
 * Lookup order:
 *   1. Settings row owned by the user (`where: { userId }`)
 *   2. Legacy unscoped row (`where: { userId: null }`) — for pre-multi-tenant data
 *   3. Hardcoded DEFAULTS
 */
export async function getExecutionSettings(userId: string | null | undefined): Promise<ExecutionSettings> {
  let row: { parallelLimit: number; maxBatchSize: number; queueAutoApprove: boolean; stopOnFailure: boolean; conflictBehavior: string } | null = null;

  if (userId) {
    row = await prisma.settings.findUnique({ where: { userId } });
  }
  if (!row) {
    row = await prisma.settings.findFirst({ where: { userId: null } });
  }

  if (!row) return { ...DEFAULTS };

  const conflictBehavior: 'skip' | 'fail' =
    row.conflictBehavior === 'fail' ? 'fail' : 'skip';

  return {
    parallelLimit: row.parallelLimit ?? DEFAULTS.parallelLimit,
    maxBatchSize: row.maxBatchSize ?? DEFAULTS.maxBatchSize,
    queueAutoApprove: row.queueAutoApprove ?? DEFAULTS.queueAutoApprove,
    stopOnFailure: row.stopOnFailure ?? DEFAULTS.stopOnFailure,
    conflictBehavior,
  };
}
