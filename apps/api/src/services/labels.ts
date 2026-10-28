import { prisma, type Prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, projectTarget, taskTarget } from '../events/targets';
import { OwnershipError, assertProjectMember, assertProjectOwned, assertTaskOwned } from './ownership';

/**
 * Labels (project-scoped) and task-label links. Every write appends its
 * event in the same transaction (W04b): the event commits or rolls back
 * with the row, instead of a best-effort broadcast after commit.
 */

export async function listLabels(input: { projectId: string; userId: string }) {
  await assertProjectMember(input.projectId, input.userId);
  return prisma.label.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ priority: 'desc' }, { name: 'asc' }],
  });
}

/** Project of a label the caller may write (full project access). */
export async function assertLabelWrite(labelId: string, userId: string): Promise<string> {
  const label = await prisma.label.findUnique({ where: { id: labelId }, select: { projectId: true } });
  if (!label) throw new OwnershipError('label', labelId, 'not_found');
  await assertProjectOwned(label.projectId, userId);
  return label.projectId;
}

export async function createLabel(input: {
  projectId: string;
  userId: string;
  name: string;
  color: string;
  priority?: number;
}) {
  await assertProjectOwned(input.projectId, input.userId);
  return transactionWithEvents(async (tx) => {
    const label = await tx.label.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        color: input.color,
        priority: input.priority ?? 0,
      },
    });
    await appendToTarget(tx, await projectTarget(tx, input.projectId), 'label:created', label, input.userId);
    return label;
  });
}

export async function updateLabel(input: {
  labelId: string;
  userId: string;
  name?: string;
  color?: string;
  priority?: number;
}) {
  const projectId = await assertLabelWrite(input.labelId, input.userId);

  const data: Prisma.LabelUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.color !== undefined) data.color = input.color;
  if (input.priority !== undefined) data.priority = input.priority;

  return transactionWithEvents(async (tx) => {
    const label = await tx.label.update({ where: { id: input.labelId }, data });
    await appendToTarget(tx, await projectTarget(tx, projectId), 'label:updated', label, input.userId);
    return label;
  });
}

export async function deleteLabel(input: { labelId: string; userId: string }): Promise<void> {
  const projectId = await assertLabelWrite(input.labelId, input.userId);
  await transactionWithEvents(async (tx) => {
    await tx.label.delete({ where: { id: input.labelId } });
    await appendToTarget(tx, await projectTarget(tx, projectId), 'label:deleted', { id: input.labelId }, input.userId);
  });
}

/**
 * Attach a label to a task. The label must belong to the task's project —
 * the same rule as `labelIds` on create/PATCH. Before, any label in a
 * project the caller could see was accepted, so a label from another
 * project (or another workspace the caller belongs to) could be attached.
 */
export async function assignLabelToTask(input: { taskId: string; labelId: string; userId: string }) {
  const task = await assertTaskOwned(input.taskId, input.userId);
  const label = await prisma.label.findUnique({ where: { id: input.labelId }, select: { projectId: true } });
  if (!label) throw new OwnershipError('label', input.labelId, 'not_found');
  if (!task.projectId || label.projectId !== task.projectId) {
    // Do not reveal whether the label exists in a project the caller cannot see.
    await assertProjectMember(label.projectId, input.userId);
    throw new HttpError(
      400,
      'LABEL_NOT_IN_TASK_PROJECT',
      task.projectId
        ? "The label belongs to a different project than the task; use one of the task's project labels"
        : 'Cannot attach labels to a task with no project',
      { taskId: input.taskId, labelId: input.labelId, taskProjectId: task.projectId ?? null },
    );
  }

  return transactionWithEvents(async (tx) => {
    const taskLabel = await tx.taskLabel.create({
      data: { taskId: input.taskId, labelId: input.labelId },
      include: { label: true },
    });
    const subject = await tx.task.findUnique({
      where: { id: input.taskId },
      select: { projectId: true, teamId: true, creatorId: true },
    });
    if (subject) {
      await appendToTarget(tx, await taskTarget(tx, subject), 'task:label:assigned', { taskId: input.taskId, label: taskLabel.label }, input.userId);
    }
    return taskLabel;
  });
}

export async function removeLabelFromTask(input: { taskId: string; labelId: string; userId: string }): Promise<void> {
  await assertTaskOwned(input.taskId, input.userId);
  await transactionWithEvents(async (tx) => {
    await tx.taskLabel.delete({ where: { taskId_labelId: { taskId: input.taskId, labelId: input.labelId } } });
    const subject = await tx.task.findUnique({
      where: { id: input.taskId },
      select: { projectId: true, teamId: true, creatorId: true },
    });
    if (subject) {
      await appendToTarget(tx, await taskTarget(tx, subject), 'task:label:removed', { taskId: input.taskId, labelId: input.labelId }, input.userId);
    }
  });
}
