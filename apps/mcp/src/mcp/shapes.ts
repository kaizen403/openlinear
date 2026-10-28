import * as z from 'zod';
import type {
  ApiComment,
  ApiDependencyRef,
  ApiLabel,
  ApiProject,
  ApiTask,
  ApiTaskRef,
  ApiTeam,
  ApiUserRef,
  ApiVerification,
  ApiWorkspace,
} from '../openlinear/api';

/*
 * Output shapes shared by the tools. They are compact on purpose (the API's
 * raw task rows carry execution logs and other bulk the model does not need)
 * and every tool result is parsed through its output schema before it is
 * sent, so `structuredContent` always matches the advertised `outputSchema`.
 */

const nullableString = z.string().nullable();

export const PHASE_LABEL_PATTERN = /^phase:(\d{1,3}) — (.+)$/;

/** `phase:N — Name` (em dash U+2014, single spaces), the dashboard's phase convention. */
export function phaseLabelName(phaseNumber: number, name: string): string {
  return `phase:${phaseNumber} — ${name}`;
}

export const DEFAULT_PHASE_COLORS = [
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#06B6D4',
  '#F97316',
  '#6366F1',
  '#14B8A6',
  '#E11D48',
] as const;

export function defaultPhaseColor(phaseNumber: number): string {
  return DEFAULT_PHASE_COLORS[(phaseNumber - 1) % DEFAULT_PHASE_COLORS.length] ?? '#3B82F6';
}

export const PhaseShape = z
  .object({ number: z.number().int(), name: z.string() })
  .describe('Parsed from a label named "phase:N — Name"');

export function parsePhase(labelName: string): z.infer<typeof PhaseShape> | null {
  const match = PHASE_LABEL_PATTERN.exec(labelName);
  if (!match?.[1] || !match[2]) return null;
  return { number: Number(match[1]), name: match[2] };
}

export const UserRefShape = z.object({ id: z.string(), username: nullableString });

function userRef(user: ApiUserRef | null | undefined): z.infer<typeof UserRefShape> | null {
  return user ? { id: user.id, username: user.username ?? null } : null;
}

export const LabelRefShape = z.object({ id: z.string(), name: z.string(), color: nullableString });

export const LabelShape = z.object({
  id: z.string(),
  name: z.string(),
  color: nullableString,
  priority: z.number().nullable(),
  phase: PhaseShape.nullable(),
});

export function toLabel(label: ApiLabel): z.infer<typeof LabelShape> {
  return {
    id: label.id,
    name: label.name,
    color: label.color ?? null,
    priority: label.priority ?? null,
    phase: parsePhase(label.name),
  };
}

export const IssueSummaryShape = z.object({
  id: z.string().describe('Issue (task) UUID'),
  identifier: nullableString.describe('Human key such as ENG-12'),
  title: z.string(),
  status: z.string().describe('todo | in_progress | done | cancelled'),
  priority: z.string().describe('low | medium | high'),
  projectId: nullableString,
  projectName: nullableString,
  teamId: nullableString,
  teamKey: nullableString,
  assignee: UserRefShape.nullable(),
  labels: z.array(LabelRefShape),
  phase: PhaseShape.nullable(),
  parentId: nullableString.describe('Parent issue UUID when this is a sub-issue'),
  dueDate: nullableString,
  prUrl: nullableString,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IssueSummary = z.infer<typeof IssueSummaryShape>;

export const IssueDetailShape = IssueSummaryShape.extend({
  description: nullableString,
  creator: UserRefShape.nullable(),
  outcome: nullableString.describe('Summary written by the agent that executed the issue'),
  model: nullableString,
  agent: nullableString,
  archived: z.boolean(),
});
export type IssueDetail = z.infer<typeof IssueDetailShape>;

/** W11a: the issue's latest verification evidence (checks run against the agent's commit before publishing). */
export const VerificationShape = z.object({
  commitSha: z.string().describe('The commit the checks ran against'),
  status: z.string().describe('passed | failed | error | skipped'),
  policy: z.string().describe('require-pass | warn | off (the project policy sealed with the run)'),
  publication: z.string().describe('allowed | blocked'),
  checks: z.array(z.object({ name: z.string(), status: z.string(), required: z.boolean() })),
  detail: nullableString,
  finishedAt: nullableString,
});
export type Verification = z.infer<typeof VerificationShape>;

export function toVerification(record: ApiVerification): Verification {
  return {
    commitSha: record.commitSha,
    status: record.status,
    policy: record.policy,
    publication: record.publication,
    checks: (record.checks ?? []).map((check) => ({ name: check.name, status: check.status, required: check.required !== false })),
    detail: record.detail ?? null,
    finishedAt: record.finishedAt ?? null,
  };
}

export function toIssueSummary(task: ApiTask): IssueSummary {
  const labels = task.labels ?? [];
  const phase = labels.map((label) => parsePhase(label.name)).find((value) => value !== null) ?? null;
  return {
    id: task.id,
    identifier: task.identifier ?? null,
    title: task.title,
    status: task.status,
    priority: task.priority,
    projectId: task.projectId ?? task.project?.id ?? null,
    projectName: task.project?.name ?? null,
    teamId: task.teamId ?? task.team?.id ?? null,
    teamKey: task.team?.key ?? null,
    assignee: userRef(task.assignee) ?? (task.assigneeId ? { id: task.assigneeId, username: null } : null),
    labels: labels.map((label) => ({ id: label.id, name: label.name, color: label.color ?? null })),
    phase,
    parentId: task.parentId ?? null,
    dueDate: task.dueDate ?? null,
    prUrl: task.prUrl ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

export function toIssueDetail(task: ApiTask): IssueDetail {
  return {
    ...toIssueSummary(task),
    description: task.description ?? null,
    creator: userRef(task.creator) ?? (task.creatorId ? { id: task.creatorId, username: null } : null),
    outcome: task.outcome ?? null,
    model: task.model ?? null,
    agent: task.agent ?? null,
    archived: task.archived ?? false,
  };
}

/** A compact reference to another issue (parent / sub-issues). */
export const IssueRefShape = z.object({
  id: z.string().describe('Issue (task) UUID'),
  identifier: nullableString.describe('Human key such as ENG-12'),
  title: z.string(),
  status: z.string().describe('todo | in_progress | done | cancelled'),
});

export function toIssueRef(task: ApiTaskRef): z.infer<typeof IssueRefShape> {
  return { id: task.id, identifier: task.identifier ?? null, title: task.title, status: task.status };
}

/** W17a: an issue in a "blocked by" relation. */
export const DependencyRefShape = IssueRefShape.extend({
  resolved: z.boolean().describe('true once that issue is done (cancelled still blocks: a failed agent run ends as cancelled)'),
});

export function toDependencyRef(task: ApiDependencyRef): z.infer<typeof DependencyRefShape> {
  return { ...toIssueRef(task), resolved: task.resolved ?? task.status === 'done' };
}

export const TeamRefShape = z.object({ id: z.string(), key: nullableString, name: nullableString });

export const ProjectShape = z.object({
  id: z.string(),
  key: nullableString,
  name: z.string(),
  description: nullableString,
  status: nullableString.describe('planned | in_progress | paused | completed | cancelled'),
  workspaceId: nullableString,
  teams: z.array(TeamRefShape),
  issueCount: z.number().nullable(),
  createdAt: nullableString,
  updatedAt: nullableString,
});
export type ProjectSummary = z.infer<typeof ProjectShape>;

export function toProject(project: ApiProject): ProjectSummary {
  return {
    id: project.id,
    key: project.key ?? null,
    name: project.name,
    description: project.description ?? null,
    status: project.status ?? null,
    workspaceId: project.workspaceId ?? project.workspace?.id ?? null,
    teams: (project.teams ?? []).map((team) => ({ id: team.id, key: team.key ?? null, name: team.name ?? null })),
    issueCount: project._count?.tasks ?? null,
    createdAt: project.createdAt ?? null,
    updatedAt: project.updatedAt ?? null,
  };
}

export const TeamMemberShape = z.object({ userId: z.string(), username: nullableString, role: nullableString });

export const TeamShape = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: nullableString,
  projectId: nullableString,
  projectName: nullableString,
  private: z.boolean().nullable(),
  memberCount: z.number().nullable(),
  issueCount: z.number().nullable(),
  members: z.array(TeamMemberShape).describe('Assignable users (user ids for assignee fields)'),
});
export type TeamSummary = z.infer<typeof TeamShape>;

export function toTeam(team: ApiTeam): TeamSummary {
  const members = (team.members ?? []).flatMap((member) => {
    const userId = member.userId ?? member.user?.id;
    return userId ? [{ userId, username: member.user?.username ?? null, role: member.role ?? null }] : [];
  });
  return {
    id: team.id,
    key: team.key,
    name: team.name,
    description: team.description ?? null,
    projectId: team.projectId ?? team.project?.id ?? null,
    projectName: team.project?.name ?? null,
    private: team.private ?? null,
    memberCount: team._count?.members ?? (team.members ? members.length : null),
    issueCount: team._count?.tasks ?? null,
    members,
  };
}

export const WorkspaceShape = z.object({
  id: z.string(),
  name: z.string(),
  slug: nullableString,
  plan: nullableString,
  role: nullableString.describe("The token owner's role in the workspace"),
  memberCount: z.number().nullable(),
  projectCount: z.number().nullable(),
});

export function toWorkspace(workspace: ApiWorkspace): z.infer<typeof WorkspaceShape> {
  return {
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug ?? null,
    plan: workspace.plan ?? null,
    role: workspace.role ?? null,
    memberCount: workspace._count?.members ?? null,
    projectCount: workspace._count?.projects ?? null,
  };
}

export const CommentShape = z.object({
  id: z.string(),
  body: z.string(),
  author: UserRefShape.nullable(),
  createdAt: z.string(),
  updatedAt: nullableString,
});

export function toComment(comment: ApiComment): z.infer<typeof CommentShape> {
  return {
    id: comment.id,
    body: comment.body,
    author: userRef(comment.user),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt ?? null,
  };
}

export const IdempotencyShape = z.object({
  key: z.string().describe('Idempotency-Key sent to the OpenLinear API'),
  replayed: z.boolean().describe('true when the API returned the result of an earlier identical call'),
});
