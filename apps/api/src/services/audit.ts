import { prisma, Prisma } from '@openlinear/db';

export interface AuditLogInput {
  workspaceId: string;
  actorId: string;
  action: string;
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
