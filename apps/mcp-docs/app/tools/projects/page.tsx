import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Project tools — OpenLinear MCP' }

export default function ProjectsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Project tools</h1>
      <p>
        Projects are the unit of planning in OpenLinear. A project lives in a workspace, owns a team
        (required, exactly one currently), and contains issues organised by phase labels.
      </p>

      <h2 id="list">openlinear_list_projects</h2>
      <p>List projects, optionally filtered.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>workspaceId</code></td><td>string (optional)</td><td>Filter by workspace.</td></tr>
          <tr><td><code>teamId</code></td><td>uuid (optional)</td><td>Filter by team.</td></tr>
        </tbody>
      </table>

      <h3>Returns</h3>
      <CodeBlock language="json">{`{
  "count": 1,
  "projects": [
    {
      "id": "...",
      "key": "MAL",
      "name": "Mobile App Launch",
      "status": "in_progress",
      "workspaceId": "...",
      "createdAt": "2026-05-22T..."
    }
  ]
}`}</CodeBlock>

      <h2 id="create">openlinear_create_project</h2>
      <p>Create a new project. Defaults to your default workspace if you don&rsquo;t pass one.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>name</code></td><td>string (1&ndash;100)</td><td>Required.</td></tr>
          <tr><td><code>description</code></td><td>string (max 1000)</td><td>Optional.</td></tr>
          <tr><td><code>key</code></td><td>string</td><td>2&ndash;12 chars, must start with a letter; stored uppercase. Auto-generated if omitted.</td></tr>
          <tr><td><code>workspaceId</code></td><td>string</td><td>Defaults to your default workspace.</td></tr>
          <tr><td><code>teamIds</code></td><td>uuid[]</td><td>Exactly one team ID (max 1 currently).</td></tr>
          <tr><td><code>status</code></td><td>enum</td><td><code>planned | in_progress | paused | completed | cancelled</code></td></tr>
        </tbody>
      </table>

      <Callout variant="info" title="No team? No problem.">
        For most workflows, just call <code>openlinear_bulk_create_plan</code> instead &mdash; it
        auto-creates a team named <code>&lt;Project&gt; Team</code> when none is supplied.
      </Callout>

      <h3>Returns</h3>
      <CodeBlock language="json">{`{
  "id": "...",
  "key": "MAL",
  "name": "Mobile App Launch",
  "status": "planned",
  "workspaceId": "..."
}`}</CodeBlock>

      <h2 id="get">openlinear_get_project</h2>
      <p>Fetch a single project by ID, including its teams and stats.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>projectId</code></td><td>uuid</td><td>Required.</td></tr>
        </tbody>
      </table>

      <PageNav />
    </div>
  )
}
