import { type Priority, type Status } from '@openlinear/db';
import { ValidationError } from '../errors';
import { prisma } from '@openlinear/db';
import { createLabel, updateLabel } from './labels';
import { assertProjectAccess, assertTeamRole, OwnershipError } from './ownership';
import { updateProject } from './projects';
import { bulkCreateTasks } from './tasks';

export interface ProjectPlanLabelInput {
  name: string;
  color?: string;
  priority?: number;
}

export interface ProjectPlanTaskInput {
  title: string;
  description?: string | null;
  priority?: Priority;
  status?: Status;
  labelNames?: string[];
  dueDate?: string | null;
  parentId?: string;
}

export interface SetupProjectPlanInput {
  userId: string;
  projectId: string;
  labels?: ProjectPlanLabelInput[];
  targetDate?: string | null;
  tasks: ProjectPlanTaskInput[];
  dryRun?: boolean;
}

const defaultLabelColor = '#6366f1';

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function colorOrDefault(value: string | undefined): string {
  return value && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : defaultLabelColor;
}

function parseDate(value: string | null | undefined, field: string): string | null | undefined {
  if (value === null || value === undefined) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${field} must be a valid ISO datetime`);
  }
  return value;
}

function uniqueLabels(labels: ProjectPlanLabelInput[] = []): ProjectPlanLabelInput[] {
  const seen = new Set<string>();
  const result: ProjectPlanLabelInput[] = [];
  for (const label of labels) {
    const name = label.name.trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ name, color: label.color, priority: label.priority });
  }
  return result;
}

export async function setupProjectPlan(input: SetupProjectPlanInput) {
  if (input.tasks.length > 100) {
    throw new ValidationError('Cannot create more than 100 tasks at once');
  }

  const targetDate = parseDate(input.targetDate, 'targetDate');
  const requestedLabels = uniqueLabels(input.labels);
  const owned = await assertProjectAccess(input.projectId, input.userId, 'full');
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: {
      id: true,
      name: true,
      targetDate: true,
      teams: { take: 1, select: { id: true } },
    },
  });
  if (!project) throw new OwnershipError('project', input.projectId, 'not_found');

  const teamId = project.teams[0]?.id ?? owned.teamIds[0];
  if (!teamId) throw new ValidationError('Project must have a team');
  await assertTeamRole(teamId, input.userId, ['owner', 'admin', 'member']);

  const existingLabels = await prisma.label.findMany({
    where: { projectId: input.projectId },
    orderBy: [{ priority: 'desc' }, { name: 'asc' }],
  });
  const labelsByName = new Map(existingLabels.map((label) => [normalizeName(label.name), label]));

  const existingTasks = await prisma.task.findMany({
    where: { projectId: input.projectId, archived: false },
    select: { id: true, identifier: true, title: true },
  });
  const existingTaskTitles = new Set(existingTasks.map((task) => normalizeTitle(task.title)));

  const normalizedTasks = input.tasks
    .map((task, index) => ({
      index,
      title: task.title.trim(),
      description: task.description ?? null,
      priority: task.priority ?? 'medium',
      status: task.status ?? 'todo',
      labelNames: [...new Set((task.labelNames ?? []).map((name) => name.trim()).filter(Boolean))],
      dueDate: parseDate(task.dueDate === undefined ? targetDate : task.dueDate, `tasks[${index}].dueDate`) ?? undefined,
      parentId: task.parentId,
    }))
    .filter((task) => task.title.length > 0);

  const skipped = normalizedTasks
    .filter((task) => existingTaskTitles.has(normalizeTitle(task.title)))
    .map((task) => ({ index: task.index, title: task.title, reason: 'An active issue with this title already exists' }));

  const duplicateIndexes = new Set(skipped.map((task) => task.index));
  const failed: Array<{ index: number; error: string }> = [];
  const tasksToCreate = normalizedTasks.filter((task) => {
    if (duplicateIndexes.has(task.index)) return false;
    const missingLabels = task.labelNames.filter((name) => !labelsByName.has(normalizeName(name)) && !requestedLabels.some((label) => normalizeName(label.name) === normalizeName(name)));
    if (missingLabels.length > 0) {
      failed.push({ index: task.index, error: `Unknown labelNames: ${missingLabels.join(', ')}` });
      return false;
    }
    return true;
  });

  if (input.dryRun) {
    return {
      dryRun: true,
      project: { id: project.id, name: project.name, targetDate },
      labels: requestedLabels.map((label) => ({
        name: label.name,
        color: colorOrDefault(label.color),
        priority: label.priority ?? 0,
        exists: labelsByName.has(normalizeName(label.name)),
      })),
      preview: tasksToCreate.map((task) => ({
        title: task.title,
        description: task.description,
        priority: task.priority,
        status: task.status,
        labelNames: task.labelNames,
        dueDate: task.dueDate ?? null,
      })),
      skipped,
      failed,
    };
  }

  const createdLabels = [];
  const updatedLabels = [];
  for (const labelInput of requestedLabels) {
    const existing = labelsByName.get(normalizeName(labelInput.name));
    const desiredColor = colorOrDefault(labelInput.color);
    const desiredPriority = labelInput.priority ?? 0;
    if (existing) {
      if (existing.name !== labelInput.name || existing.color !== desiredColor || existing.priority !== desiredPriority) {
        const updated = await updateLabel({
          labelId: existing.id,
          userId: input.userId,
          name: labelInput.name,
          color: desiredColor,
          priority: desiredPriority,
        });
        labelsByName.set(normalizeName(updated.name), updated);
        updatedLabels.push(updated);
      }
    } else {
      const created = await createLabel({
        projectId: input.projectId,
        userId: input.userId,
        name: labelInput.name,
        color: desiredColor,
        priority: desiredPriority,
      });
      labelsByName.set(normalizeName(created.name), created);
      createdLabels.push(created);
    }
  }

  const updatedProject = targetDate !== undefined
    ? await updateProject({ userId: input.userId, projectId: input.projectId, targetDate })
    : null;

  const createResult = await bulkCreateTasks({
    userId: input.userId,
    projectId: input.projectId,
    dryRun: false,
    tasks: tasksToCreate.map((task) => ({
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      dueDate: task.dueDate ?? null,
      parentId: task.parentId,
      labelIds: task.labelNames
        .map((name) => labelsByName.get(normalizeName(name))?.id)
        .filter((id): id is string => Boolean(id)),
    })),
  });

  return {
    dryRun: false,
    project: {
      id: updatedProject?.id ?? project.id,
      name: updatedProject?.name ?? project.name,
      targetDate: updatedProject?.targetDate ?? project.targetDate,
    },
    labels: {
      created: createdLabels,
      updated: updatedLabels,
      available: Array.from(labelsByName.values()),
    },
    created: createResult.created,
    skipped,
    failed: [...failed, ...createResult.failed],
  };
}
