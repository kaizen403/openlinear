import { prisma, type Prisma } from '@openlinear/db';
import { broadcastToProject } from '../sse';
import { OwnershipError, assertProjectMember } from './ownership';

export async function listLabels(input: { projectId: string; userId: string }) {
  await assertProjectMember(input.projectId, input.userId);
  return prisma.label.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ priority: 'desc' }, { name: 'asc' }],
  });
}

export async function createLabel(input: {
  projectId: string;
  userId: string;
  name: string;
  color: string;
  priority?: number;
}) {
  await assertProjectMember(input.projectId, input.userId);
  const label = await prisma.label.create({
    data: {
      projectId: input.projectId,
      name: input.name,
      color: input.color,
      priority: input.priority ?? 0,
    },
  });
  await broadcastToProject(input.projectId, 'label:created', label);
  return label;
}

export async function updateLabel(input: {
  labelId: string;
  userId: string;
  name?: string;
  color?: string;
  priority?: number;
}) {
  const existing = await prisma.label.findUnique({
    where: { id: input.labelId },
    select: { projectId: true },
  });
  if (!existing) {
    throw new OwnershipError('label', input.labelId, 'not_found');
  }
  await assertProjectMember(existing.projectId, input.userId);

  const data: Prisma.LabelUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.color !== undefined) data.color = input.color;
  if (input.priority !== undefined) data.priority = input.priority;

  const label = await prisma.label.update({
    where: { id: input.labelId },
    data,
  });
  await broadcastToProject(existing.projectId, 'label:updated', label);
  return label;
}
