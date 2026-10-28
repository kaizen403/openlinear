import { prisma, type Prisma } from '@openlinear/db';
import { logger } from '../logger';

/**
 * Account-level security audit (W02b).
 *
 * `logAudit` (services/audit.ts) writes `audit_logs`, which requires a
 * workspace and cascades with it. Credential events that belong to a user,
 * not a workspace, were therefore not recorded at all: creating or revoking
 * an account-wide personal access token, detecting refresh-token reuse, and
 * the one-off PAT remediation. They are recorded here instead.
 */
export const ACCOUNT_AUDIT_ACTIONS = [
  'pat.created',
  'pat.revoked',
  'pat.remediated',
  'session.refresh_reuse_detected',
] as const;

export type AccountAuditAction = (typeof ACCOUNT_AUDIT_ACTIONS)[number];

export interface AccountAuditInput {
  userId: string;
  /** Who performed the action; `null` for system actions (remediation). */
  actorId: string | null;
  action: AccountAuditAction;
  resourceType: string;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string | null;
}

type Db = Prisma.TransactionClient | typeof prisma;

function toData(input: AccountAuditInput): Prisma.AccountAuditLogUncheckedCreateInput {
  return {
    userId: input.userId,
    actorId: input.actorId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    metadata: input.metadata ?? undefined,
    ipAddress: input.ipAddress ?? null,
  };
}

/** Append-only. Use inside the caller's transaction when there is one. */
export async function logAccountAudit(input: AccountAuditInput, db: Db = prisma): Promise<void> {
  await db.accountAuditLog.create({ data: toData(input) });
}

/**
 * For paths where the audited action has already committed and must not be
 * reported as failed because the audit write failed (it is logged instead).
 */
export async function logAccountAuditBestEffort(input: AccountAuditInput): Promise<void> {
  try {
    await logAccountAudit(input);
  } catch (err) {
    logger.error({ err, action: input.action, userId: input.userId }, '[audit] account audit write failed');
  }
}
