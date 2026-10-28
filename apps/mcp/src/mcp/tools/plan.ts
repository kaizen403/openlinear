import * as z from 'zod';
import type { ApiLabel, BulkTaskBody } from '../../openlinear/api';
import { describeFailure, type FailureContext, ToolInputError } from '../errors';
import { canonicalJson, deriveIdempotencyKey, sha256Hex } from '../idempotency';
import { HexColor, id, IdempotencyKeyArg, IssuePriority, ProjectKey, WorkspaceId } from '../inputs';
import { defaultPhaseColor, IdempotencyShape, phaseLabelName } from '../shapes';
import { defineTool } from '../tool';
import { ensureLabel } from './labels';

/** The API accepts 256 KB per request and 100 tasks per bulk call; stay well below. */
const MAX_CHUNK_BYTES = 200_000;
const MAX_CHUNK_TASKS = 100;
/** After these failures every later call would fail the same way, so later phases are skipped. */
const FATAL_CODES = new Set(['UNAUTHORIZED', 'INSUFFICIENT_SCOPE', 'RATE_LIMITED', 'CANCELLED']);

/** Projects + teams, phase labels (and reading them back) and issues; or the generic write scope. */
const PLAN_SCOPES = ['write', 'projects:write + labels:write + tasks:write'] as const;

const encoder = new TextEncoder();

const TaskKey = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, 'letters, digits, dot, dash or underscore');

interface PlanTaskRef {
  key?: string;
  blockedBy?: string[];
}

/**
 * W17a: plan-level "blocked by" between tasks, by their `key`. Checked before
 * anything is created: keys unique, every blocker known, no self-edge, no
 * loop. Returns the edges as [task key, blocker key].
 */
export function planDependencies(phases: ReadonlyArray<{ tasks: readonly PlanTaskRef[] }>): Array<[string, string]> {
  const keys = new Set<string>();
  for (const task of phases.flatMap((phase) => phase.tasks)) {
    if (!task.key) continue;
    if (keys.has(task.key)) throw new ToolInputError(`Task key "${task.key}" is used twice; keys must be unique in the plan.`);
    keys.add(task.key);
  }
  const edges: Array<[string, string]> = [];
  for (const task of phases.flatMap((phase) => phase.tasks)) {
    for (const blocker of new Set(task.blockedBy ?? [])) {
      if (!task.key) throw new ToolInputError(`A task lists blockedBy ["${blocker}"] but has no key; give it a key too.`);
      if (blocker === task.key) throw new ToolInputError(`Task "${task.key}" cannot block itself.`);
      if (!keys.has(blocker)) throw new ToolInputError(`Task "${task.key}" is blocked by "${blocker}", which is not a task key in this plan.`);
      edges.push([task.key, blocker]);
    }
  }
  // Kahn: every task must become ready once its blockers are.
  const waiting = new Map<string, Set<string>>([...keys].map((key) => [key, new Set<string>()]));
  for (const [task, blocker] of edges) waiting.get(task)?.add(blocker);
  const done = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [key, blockers] of waiting) {
      if (done.has(key) || [...blockers].some((blocker) => !done.has(blocker))) continue;
      done.add(key);
      progressed = true;
    }
  }
  const looped = [...keys].filter((key) => !done.has(key));
  if (looped.length > 0) throw new ToolInputError(`These tasks block each other in a loop: ${looped.join(', ')}. Remove one blockedBy.`);
  return edges;
}

export function chunkTasks(items: BulkTaskBody[]): BulkTaskBody[][] {
  const chunks: BulkTaskBody[][] = [];
  let current: BulkTaskBody[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (current.length > 0 && (current.length >= MAX_CHUNK_TASKS || bytes + size > MAX_CHUNK_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const planInput = z.strictObject({
  workspaceId: WorkspaceId.optional().describe("Defaults to your default workspace (or the token's bound workspace)"),
  teamId: id('Team')
    .optional()
    .describe(
      'Optional: move this existing team (and its issue numbering) into the new project instead of creating a default team. Needs owner/admin on the team; it must be in the same workspace, not the last team of its project and have no issues there (else TEAM_PROJECT_CONFLICT, nothing created)',
    ),
  project: z.strictObject({
    name: z.string().trim().min(1).max(100).describe('Project name'),
    description: z.string().max(1000).optional().describe('Short project description'),
    key: ProjectKey.optional().describe('Issue prefix such as BILL; generated from the name if omitted'),
  }).describe('The project to create'),
  phases: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(40).describe('Phase name, e.g. Foundation'),
        description: z
          .string()
          .max(500)
          .optional()
          .describe('Accepted for compatibility; labels have no description, so it is not stored'),
        color: HexColor.optional(),
        tasks: z
          .array(
            z.strictObject({
              title: z.string().trim().min(1).max(500),
              description: z.string().max(10000).optional().describe('Markdown'),
              priority: IssuePriority.default('medium'),
              key: TaskKey.optional().describe('Your handle for this task (unique in the plan) so other tasks can list it in blockedBy'),
              blockedBy: z
                .array(TaskKey)
                .max(20)
                .optional()
                .describe('Keys of tasks in this plan that must be done first; agents run this task only after them'),
            }),
          )
          .min(1)
          .max(50),
      }),
    )
    .min(1)
    .max(10)
    .describe('Ordered phases; phase N becomes the label "phase:N — Name"'),
  idempotencyKey: IdempotencyKeyArg.optional(),
});

const phaseResult = z.object({
  name: z.string(),
  number: z.number().int(),
  labelId: z.string().optional(),
  labelName: z.string().optional(),
  labelReused: z.boolean().optional().describe('The phase label already existed'),
  taskCount: z.number().int(),
  taskIds: z.array(z.string()),
  failed: z
    .array(z.object({ index: z.number().int(), error: z.string() }))
    .optional()
    .describe('Tasks of this phase the API refused (index into the phase tasks)'),
  error: z.string().optional().describe('Why this phase (or the rest of it) was not created'),
  replayed: z.boolean().optional().describe('The tasks came from an earlier identical call'),
});

const dependencyResult = z
  .object({
    requested: z.number().int(),
    added: z.number().int(),
    existing: z.number().int().describe('Already recorded by an earlier identical call'),
    failed: z.array(z.object({ task: z.string(), blockedBy: z.string(), error: z.string() })),
  })
  .describe('Blockers between plan tasks (only when tasks use blockedBy)');

type PhaseResult = z.infer<typeof phaseResult>;

export const bulkCreatePlan = defineTool({
  name: 'openlinear_bulk_create_plan',
  title: 'Create project plan',
  description:
    'Create a project, one "phase:N — Name" label per phase and every task (as todo issues) in one call: the fastest way to turn a multi-phase plan into OpenLinear issues. Not atomic: the result lists exactly what was created; on status "partial", call again with identical arguments within 24 hours to finish it without duplicates.',
  input: planInput,
  output: z.object({
    status: z.enum(['complete', 'partial']),
    summary: z.string(),
    projectId: z.string(),
    projectKey: z.string().nullable(),
    projectName: z.string(),
    teamId: z.string().nullable(),
    totalTasks: z.number().int(),
    phases: z.array(phaseResult),
    dependencies: dependencyResult.optional(),
    idempotency: IdempotencyShape.describe('Key and replay flag of the project-creation step'),
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  scopes: PLAN_SCOPES,
  async run(args, { api, signal, toolName }) {
    const failureContext: FailureContext = { tool: toolName, scopes: PLAN_SCOPES, safeToRetry: true };
    const edges = planDependencies(args.phases);
    const plan = await sha256Hex(canonicalJson({ v: 1, tool: toolName, args }));

    // 1. Project (transactional Idempotency-Key, kept 24 h). A failure here created nothing to report.
    const projectKey = await deriveIdempotencyKey(toolName, 'plan.project', { plan });
    const createdProject = await api.createProject(
      {
        name: args.project.name,
        description: args.project.description,
        key: args.project.key,
        workspaceId: args.workspaceId,
        status: 'planned',
        ...(args.teamId ? { teamIds: [args.teamId] } : {}),
      },
      projectKey,
      signal,
    );
    const project = createdProject.value;

    // 2. Team: every new project gets a default team; create one only if it is missing.
    let teamId = project.teams?.[0]?.id ?? args.teamId ?? null;
    let teamError: string | undefined;
    if (!teamId) {
      try {
        const teamKey =
          (project.key ?? 'TEAM')
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '')
            .slice(0, 10) || 'TEAM';
        const team = await api.createTeam(
          { projectId: project.id, name: `${project.name} Team`.slice(0, 50), key: /^[A-Z]/.test(teamKey) ? teamKey : 'TEAM' },
          await deriveIdempotencyKey(toolName, 'plan.team', { plan, projectId: project.id }),
          signal,
        );
        teamId = team.value.id;
      } catch (error) {
        teamError = describeFailure(error, failureContext).message;
      }
    }

    // 3. Phases, in order, so issue numbers follow the plan.
    let existing = new Map<string, ApiLabel>();
    try {
      existing = new Map((await api.listLabels(project.id, signal)).map((label) => [label.name, label]));
    } catch {
      // ensureLabel below still copes with labels that already exist.
    }

    const phases: PhaseResult[] = [];
    let fatal: string | undefined;
    for (const [index, phase] of args.phases.entries()) {
      const number = index + 1;
      const labelName = phaseLabelName(number, phase.name);
      if (fatal) {
        phases.push({ name: phase.name, number, taskCount: 0, taskIds: [], error: `Skipped: ${fatal}` });
        continue;
      }
      const taskIds: string[] = [];
      const failed: Array<{ index: number; error: string }> = [];
      let label: ApiLabel | undefined;
      let labelReused = false;
      let replayed = true;
      try {
        label = existing.get(labelName);
        labelReused = label !== undefined;
        if (!label) {
          const ensured = await ensureLabel(
            api,
            { projectId: project.id, name: labelName, color: phase.color ?? defaultPhaseColor(number), priority: index },
            signal,
          );
          label = ensured.label;
          labelReused = !ensured.created;
        }
        const labelId = label.id;
        const items: BulkTaskBody[] = phase.tasks.map((task) => ({
          title: task.title,
          description: task.description,
          priority: task.priority,
          status: 'todo',
          labelIds: [labelId],
        }));
        let offset = 0;
        for (const [chunkIndex, chunk] of chunkTasks(items).entries()) {
          const key = await deriveIdempotencyKey(toolName, `plan.phase.${number}.${chunkIndex}`, {
            plan,
            projectId: project.id,
            tasks: chunk,
          });
          const result = await api.bulkCreateTasks({ projectId: project.id, tasks: chunk }, key, signal);
          taskIds.push(...result.value.created.map((task) => task.id));
          failed.push(...result.value.failed.map((failure) => ({ index: failure.index + offset, error: failure.error })));
          replayed &&= result.replayed;
          offset += chunk.length;
        }
        phases.push({
          name: phase.name,
          number,
          labelId,
          labelName: label.name,
          labelReused,
          taskCount: taskIds.length,
          taskIds,
          ...(failed.length > 0 ? { failed } : {}),
          replayed,
        });
      } catch (error) {
        const failure = describeFailure(error, failureContext);
        if (FATAL_CODES.has(failure.code)) fatal = failure.message;
        phases.push({
          name: phase.name,
          number,
          ...(label ? { labelId: label.id, labelName: label.name, labelReused } : {}),
          taskCount: taskIds.length,
          taskIds,
          ...(failed.length > 0 ? { failed } : {}),
          error: teamError ? `${failure.message} (team creation failed: ${teamError})` : failure.message,
        });
      }
    }

    // 4. Blockers between plan tasks (W17a), once every task exists. Each
    // edge is idempotent, so a re-run finishes a partial plan.
    let dependencies: z.infer<typeof dependencyResult> | undefined;
    if (edges.length > 0) {
      const idsByKey = new Map<string, string>();
      for (const [phaseIndex, phase] of args.phases.entries()) {
        const result = phases[phaseIndex];
        if (!result) continue;
        const refused = new Set((result.failed ?? []).map((failure) => failure.index));
        let next = 0;
        for (const [taskIndex, task] of phase.tasks.entries()) {
          if (refused.has(taskIndex)) continue;
          const createdId = result.taskIds[next];
          next += 1;
          if (task.key && createdId) idsByKey.set(task.key, createdId);
        }
      }
      dependencies = { requested: edges.length, added: 0, existing: 0, failed: [] };
      for (const [taskKey, blockerKey] of edges) {
        const taskId = idsByKey.get(taskKey);
        const blockerId = idsByKey.get(blockerKey);
        if (fatal || !taskId || !blockerId) {
          dependencies.failed.push({ task: taskKey, blockedBy: blockerKey, error: fatal ? `Skipped: ${fatal}` : 'Not added: one of the two tasks was not created' });
          continue;
        }
        try {
          const added = await api.addBlocker(taskId, blockerId, signal);
          if (added.created) dependencies.added += 1;
          else dependencies.existing += 1;
        } catch (error) {
          const failure = describeFailure(error, failureContext);
          if (FATAL_CODES.has(failure.code)) fatal = failure.message;
          dependencies.failed.push({ task: taskKey, blockedBy: blockerKey, error: failure.message });
        }
      }
    }

    const totalTasks = phases.reduce((sum, phase) => sum + phase.taskCount, 0);
    const requested = args.phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
    const complete = phases.every((phase) => !phase.error && !phase.failed) && (dependencies?.failed.length ?? 0) === 0;
    const name = `${project.key ?? project.name} (${project.name})`;
    const blockerNote = dependencies ? ` and ${dependencies.added + dependencies.existing} blockers` : '';
    const summary = complete
      ? `Created project ${name} with ${phases.length} phases and ${totalTasks} issues${blockerNote}${createdProject.replayed ? ' (returned from an earlier identical call)' : ''}.`
      : `PARTIAL: project ${name} exists; ${totalTasks} of ${requested} issues were created and ${
          phases.filter((phase) => phase.error || phase.failed).length
        } of ${phases.length} phases had failures (see phases[].error / failed)${
          dependencies && dependencies.failed.length > 0 ? `; ${dependencies.failed.length} of ${dependencies.requested} blockers were not added (see dependencies.failed)` : ''
        }. Call openlinear_bulk_create_plan again with identical arguments within 24 hours to finish: completed steps are replayed, not duplicated.`;

    const status: 'complete' | 'partial' = complete ? 'complete' : 'partial';
    return {
      status,
      summary,
      projectId: project.id,
      projectKey: project.key ?? null,
      projectName: project.name,
      teamId,
      totalTasks,
      phases,
      ...(dependencies ? { dependencies } : {}),
      idempotency: { key: projectKey, replayed: createdProject.replayed },
    };
  },
});
