import { ToolCard } from '@/components/tool-card'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Tools — OpenLinear MCP' }

export default function ToolsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Tools reference</h1>
      <p>
        OpenLinear MCP exposes 12 tools across 7 domains: workspaces, projects, teams, labels, phases,
        issues, and the headline <code>bulk_create_plan</code>. Every tool is strongly typed with Zod
        and returns a structured JSON result.
      </p>

      <h2>By domain</h2>

      <div className="not-prose grid gap-3">
        {sections.map((s) => (
          <div key={s.title}>
            <h3 className="mb-2 font-display text-base font-semibold text-white">{s.title}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {s.tools.map((t) => (
                <ToolCard key={t.name} {...t} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <PageNav />
    </div>
  )
}

const sections = [
  {
    title: 'Workspaces',
    tools: [
      { name: 'openlinear_list_workspaces', href: '/tools/workspaces', description: 'Return all workspaces your token can access.' },
    ],
  },
  {
    title: 'Projects',
    tools: [
      { name: 'openlinear_list_projects', href: '/tools/projects', description: 'List projects, optionally filtered by workspace or team.' },
      { name: 'openlinear_create_project', href: '/tools/projects', description: 'Create a project; defaults to your default workspace.' },
      { name: 'openlinear_get_project', href: '/tools/projects', description: 'Fetch a single project by ID.' },
    ],
  },
  {
    title: 'Teams',
    tools: [
      { name: 'openlinear_list_teams', href: '/tools/teams', description: 'List teams. Teams belong to projects.' },
      { name: 'openlinear_create_team', href: '/tools/teams', description: 'Create a team inside a project.' },
    ],
  },
  {
    title: 'Labels',
    tools: [
      { name: 'openlinear_list_labels', href: '/tools/labels', description: 'List labels for a project, including phase labels.' },
      { name: 'openlinear_create_label', href: '/tools/labels', description: 'Create a project-scoped label.' },
    ],
  },
  {
    title: 'Phases',
    tools: [
      { name: 'openlinear_create_phase', href: '/tools/phases', description: 'Create a phase label using the phase:N convention.' },
    ],
  },
  {
    title: 'Issues',
    tools: [
      { name: 'openlinear_create_issue', href: '/tools/issues', description: 'Create a single issue (task).' },
      { name: 'openlinear_update_issue', href: '/tools/issues', description: 'Update an issue: status, priority, labels, assignee.' },
    ],
  },
  {
    title: 'Bulk planning',
    tools: [
      { name: 'openlinear_bulk_create_plan', href: '/tools/bulk-create-plan', description: 'Project + phases + tasks in a single call. The headline tool.' },
    ],
  },
]
