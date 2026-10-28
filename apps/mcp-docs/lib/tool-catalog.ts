import data from './tool-catalog.json'

/*
 * The tool catalogue is generated from the live MCP server's `tools/list`
 * by apps/mcp/test/catalog.test.ts, which also fails when this file drifts
 * from the server. Never edit tool-catalog.json by hand.
 */

export interface ToolInput {
  name: string
  type: string
  required: boolean
  default?: unknown
  description: string
}

export interface ToolEntry {
  name: string
  title: string
  description: string
  annotations: {
    readOnlyHint: boolean
    destructiveHint: boolean
    idempotentHint: boolean
    openWorldHint: boolean
  }
  scopes: string[]
  inputs: ToolInput[]
}

export interface ToolCatalog {
  serverVersion: string
  endpoint: string
  tools: ToolEntry[]
}

export const catalog: ToolCatalog = data

export const TOOL_COUNT = catalog.tools.length

export function getTool(name: string): ToolEntry {
  const entry = catalog.tools.find((candidate) => candidate.name === name)
  if (!entry) throw new Error(`Unknown tool ${name}: regenerate lib/tool-catalog.json`)
  return entry
}

/** Tools grouped for the reference pages, in tools/list order. */
export const TOOL_GROUPS: Array<{ title: string; href: string; tools: string[] }> = [
  { title: 'Workspaces', href: '/tools/workspaces', tools: ['openlinear_list_workspaces'] },
  {
    title: 'Projects',
    href: '/tools/projects',
    tools: ['openlinear_list_projects', 'openlinear_get_project', 'openlinear_create_project'],
  },
  { title: 'Teams', href: '/tools/teams', tools: ['openlinear_list_teams', 'openlinear_create_team'] },
  { title: 'Labels', href: '/tools/labels', tools: ['openlinear_list_labels', 'openlinear_create_label'] },
  { title: 'Phases', href: '/tools/phases', tools: ['openlinear_create_phase'] },
  {
    title: 'Issues',
    href: '/tools/issues',
    tools: [
      'openlinear_search',
      'openlinear_list_issues',
      'openlinear_get_issue',
      'openlinear_find_similar_issues',
      'openlinear_create_issue',
      'openlinear_update_issue',
      'openlinear_assign_issue',
      'openlinear_label_issue',
      'openlinear_set_blockers',
      'openlinear_bulk_update_status',
      'openlinear_add_comment',
    ],
  },
  { title: 'Bulk planning', href: '/tools/bulk-create-plan', tools: ['openlinear_bulk_create_plan'] },
  {
    title: 'Reviewable plans',
    href: '/tools/plans',
    tools: ['openlinear_list_plans', 'openlinear_propose_plan', 'openlinear_get_plan', 'openlinear_revise_plan', 'openlinear_approve_plan'],
  },
  { title: 'Recurring issues', href: '/tools/schedules', tools: ['openlinear_list_schedules', 'openlinear_create_schedule'] },
  { title: 'Project knowledge', href: '/tools/knowledge', tools: ['openlinear_list_knowledge', 'openlinear_propose_knowledge'] },
  { title: 'Insights', href: '/tools/insights', tools: ['openlinear_get_insights'] },
]
