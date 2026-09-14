import { prisma, Prisma } from '@openlinear/db';

export const AUDIT_ACTIONS = [
  'pat.created',
  'pat.revoked',
  'sso.configured',
  'sso.deleted',
  'workspace.member_removed',
  'workspace.deleted',
  'project.deleted',
  'task.bulk_deleted',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditLogInput {
  workspaceId: string;
  actorId: string;
  action: AuditAction | string;
  resourceType: string;
  resourceId: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
}

/**
 * Append-only audit log entry. Never updates or deletes.
 */
export async function logAudit(input: AuditLogInput) {
  return prisma.auditLog.create({
    data: {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata ?? undefined,
      ipAddress: input.ipAddress,
    },
  });
}
