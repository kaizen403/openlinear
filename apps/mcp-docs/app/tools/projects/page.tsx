import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Project tools — OpenLinear MCP' }

export default function ProjectsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Project tools</h1>
      <p>
        Projects are the unit of planning. A project lives in a workspace, gets its own default team (which numbers its
        issues, e.g. <code>BILL-12</code>) and default labels, and groups issues by phase labels.
      </p>

      <ToolReference name="openlinear_list_projects">
        <h3>Returns</h3>
        <CodeBlock language="json">{`{
  "projects": [
    {
      "id": "…",
      "key": "BILL",
      "name": "Stripe Billing",
      "description": null,
      "status": "planned",
      "workspaceId": "…",
      "teams": [{ "id": "…", "key": "BILL", "name": "Stripe Billing Team" }],
      "issueCount": 7,
      "createdAt": "2026-10-25T09:00:00.000Z",
      "updatedAt": "2026-10-25T09:00:00.000Z"
    }
  ],
  "total": 1,
  "truncated": false
}`}</CodeBlock>
      </ToolReference>

      <ToolReference name="openlinear_get_project">
        <p>
          Returns the project plus its repository, workspace and every label (phase labels include a parsed{' '}
          <code>phase</code>). List the project&rsquo;s issues with <code>openlinear_list_issues</code>.
        </p>
      </ToolReference>

      <ToolReference name="openlinear_create_project">
        <Callout variant="info" title="Planning a whole project?">
          Use <code>openlinear_bulk_create_plan</code> instead: it creates the project, phase labels and every task in
          one call.
        </Callout>
        <p>
          Retrying the same call within 24 hours returns the same project (<code>idempotency.replayed: true</code>)
          instead of creating a second one.
        </p>
        <h3>Adopting an existing team</h3>
        <p>
          By default a new project gets its own team, which numbers its issues. <code>teamIds</code> (one team) moves
          an existing team into the new project instead, together with its issue numbering and its issues that have
          no project. The move is allowed when you are owner or admin of the team and it leaves nothing inconsistent;
          otherwise nothing is created and the error lists a reason per team:
        </p>
        <table>
          <thead><tr><th>Reason</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td><code>OTHER_WORKSPACE</code></td><td>The team&rsquo;s current project is in another workspace.</td></tr>
            <tr><td><code>LAST_TEAM_OF_PROJECT</code></td><td>Its current project would be left without a team.</td></tr>
            <tr><td><code>TEAM_HAS_PROJECT_TASKS</code></td><td>The team still has issues in its current project.</td></tr>
            <tr><td><code>TEAM_KEY_TAKEN</code></td><td>Another team of the project already uses its key.</td></tr>
          </tbody>
        </table>
      </ToolReference>

      <PageNav />
    </div>
  )
}
