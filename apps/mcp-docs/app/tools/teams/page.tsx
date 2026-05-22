import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Team tools — OpenLinear MCP' }

export default function TeamsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Team tools</h1>
      <p>
        Teams are the issue-numbering boundary in OpenLinear. Every issue is identified as
        <code>&lt;TEAM_KEY&gt;-&lt;N&gt;</code> (e.g. <code>MAL-42</code>), with numbers atomically
        incremented per team.
      </p>

      <h2 id="list">openlinear_list_teams</h2>
      <p>List teams, optionally filtered.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>projectId</code></td><td>uuid (optional)</td><td>Filter to a single project&rsquo;s teams.</td></tr>
          <tr><td><code>workspaceId</code></td><td>string (optional)</td><td>Filter to a workspace.</td></tr>
        </tbody>
      </table>

      <h2 id="create">openlinear_create_team</h2>
      <p>Create a team inside a project. Team keys must start with a letter and are stored uppercase.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>projectId</code></td><td>uuid</td><td>Required.</td></tr>
          <tr><td><code>name</code></td><td>string (1&ndash;50)</td><td>Required.</td></tr>
          <tr><td><code>key</code></td><td>string (1&ndash;10)</td><td>Must match <code>/^[A-Za-z][A-Za-z0-9]*$/</code>. Uppercased.</td></tr>
          <tr><td><code>description</code></td><td>string (max 500)</td><td>Optional.</td></tr>
          <tr><td><code>color</code></td><td>string</td><td><code>#RRGGBB</code></td></tr>
          <tr><td><code>icon</code></td><td>string (max 50)</td><td>Optional.</td></tr>
          <tr><td><code>private</code></td><td>boolean</td><td>Defaults to false.</td></tr>
        </tbody>
      </table>

      <h3>Example</h3>
      <CodeBlock language="json">{`{
  "tool": "openlinear_create_team",
  "input": {
    "projectId": "...",
    "name": "Platform",
    "key": "PLT",
    "color": "#10B981"
  }
}`}</CodeBlock>

      <PageNav />
    </div>
  )
}
