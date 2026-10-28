import { McpServer } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from '../version';
import type { RequestScope } from './context';
import type { RegisteredToolSpec } from './tool';
import {
  addComment,
  assignIssue,
  bulkUpdateStatus,
  createIssue,
  findSimilarIssues,
  getIssue,
  labelIssue,
  listIssues,
  setBlockers,
  updateIssue,
} from './tools/issues';
import { createLabel, createPhase, listLabels } from './tools/labels';
import { bulkCreatePlan } from './tools/plan';
import { approvePlan, getPlan, listPlans, proposePlan, revisePlan } from './tools/plan-review';
import { createProject, getProject, listProjects } from './tools/projects';
import { createSchedule, listSchedules } from './tools/schedules';
import { listKnowledge, proposeKnowledge } from './tools/knowledge';
import { getInsights } from './tools/insights';
import { search } from './tools/search';
import { createTeam, listTeams } from './tools/teams';
import { listWorkspaces } from './tools/workspaces';

/** Every tool, in the deterministic order `tools/list` returns them. */
export const TOOLS: readonly RegisteredToolSpec[] = [
  listWorkspaces,
  listProjects,
  getProject,
  createProject,
  listTeams,
  createTeam,
  listLabels,
  createLabel,
  createPhase,
  search,
  listIssues,
  getIssue,
  findSimilarIssues,
  createIssue,
  updateIssue,
  assignIssue,
  labelIssue,
  setBlockers,
  bulkUpdateStatus,
  addComment,
  bulkCreatePlan,
  listPlans,
  proposePlan,
  getPlan,
  revisePlan,
  approvePlan,
  listSchedules,
  createSchedule,
  listKnowledge,
  proposeKnowledge,
  getInsights,
];

export const INSTRUCTIONS = [
  'OpenLinear is a project tracker whose issues are executed by coding agents.',
  'Find work: openlinear_list_workspaces → openlinear_list_projects → openlinear_list_issues, openlinear_search, openlinear_get_issue (accepts identifiers such as ENG-12).',
  'Plan work: openlinear_bulk_create_plan turns a multi-phase plan into a project, phase labels and issues in one call; phases are labels named "phase:N — Name".',
  'Plans for review: openlinear_propose_plan stores a draft (tasks with acceptance checks, estimates and blockers) that people review in OpenLinear; openlinear_revise_plan / openlinear_get_plan iterate on it; openlinear_approve_plan creates the issues, only when the user asks.',
  'Manage work: openlinear_update_issue, openlinear_assign_issue, openlinear_label_issue, openlinear_set_blockers, openlinear_bulk_update_status, openlinear_add_comment.',
  'Order work: openlinear_set_blockers marks an issue as blocked by others in its project; agents run blocked issues only after their blockers are done.',
  'Recurring issues: openlinear_create_schedule creates an issue every day, weekday, week or month at a local time; openlinear_list_schedules shows existing ones. Schedules create issues only; they never run them.',
  'Project knowledge: openlinear_list_knowledge shows the conventions and procedures every run in a project is given (read it before working there); openlinear_propose_knowledge saves a proposal a person approves in OpenLinear.',
  'Insights: openlinear_get_insights reports agent run outcomes, verification and pull request rates, duration, known cost (unknown prices counted, never $0) and delivery (created vs completed, cycle time, blocked now) for a project or workspace over 7, 30 or 90 days.',
  'Lists page with an opaque cursor: repeat the call with the same filters and cursor = nextCursor while hasMore is true.',
  'Ids are UUIDs from earlier results. Creates are safe to retry with identical arguments.',
].join('\n');

/** A fresh server for one HTTP request (the SDK serves every request statelessly). */
export function createOpenLinearServer(scope: RequestScope): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      websiteUrl: 'https://openlinear.tech',
    },
    {
      instructions: INSTRUCTIONS,
      // The tool list never changes during a deployment.
      capabilities: { tools: { listChanged: false } },
      maxToolInputElements: 5_000,
    },
  );
  for (const tool of TOOLS) tool.register(server, scope);
  return server;
}
