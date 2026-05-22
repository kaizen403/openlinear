import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Issue tools — OpenLinear MCP' }

export default function IssuesPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Issue tools</h1>
      <p>
        Issues are tasks in OpenLinear. Each issue belongs to a team (for numbering) and optionally to
        a project. They carry labels, status, priority, and an optional assignee or model preference.
      </p>

      <h2 id="create">openlinear_create_issue</h2>
      <p>Create a single issue. Provide either a <code>projectId</code> or a <code>teamId</code>.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>title</code></td><td>string (1&ndash;500)</td><td>Required.</td></tr>
          <tr><td><code>description</code></td><td>string (max 10000)</td><td>Markdown supported.</td></tr>
          <tr><td><code>priority</code></td><td>enum</td><td><code>low | medium | high</code> (default: medium)</td></tr>
          <tr><td><code>status</code></td><td>enum</td><td><code>todo | in_progress | done | cancelled</code></td></tr>
          <tr><td><code>projectId</code></td><td>uuid</td><td>Either this or <code>teamId</code> is required.</td></tr>
          <tr><td><code>teamId</code></td><td>uuid</td><td>Either this or <code>projectId</code> is required.</td></tr>
          <tr><td><code>labelIds</code></td><td>uuid[]</td><td>Attach labels (including phase labels).</td></tr>
          <tr><td><code>dueDate</code></td><td>ISO datetime | null</td><td>Optional.</td></tr>
          <tr><td><code>model</code></td><td>string | null</td><td>Preferred AI model for execution.</td></tr>
        </tbody>
      </table>

      <Callout variant="info">
        If you pass <code>projectId</code> alone, the API resolves the team from the project automatically.
        Bulk operations use <code>projectId</code> for this reason.
      </Callout>

      <h3>Example</h3>
      <CodeBlock language="json">{`{
  "tool": "openlinear_create_issue",
  "input": {
    "projectId": "...",
    "title": "Add JWT refresh endpoint",
    "description": "POST /api/auth/refresh returning a new short-lived token.",
    "priority": "high",
    "labelIds": ["label_phase_1_uuid"]
  }
}`}</CodeBlock>

      <h2 id="update">openlinear_update_issue</h2>
      <p>Patch any field on an existing issue. All fields are optional &mdash; pass only what changes.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>taskId</code></td><td>uuid</td><td>Required.</td></tr>
          <tr><td><code>title</code></td><td>string</td><td></td></tr>
          <tr><td><code>description</code></td><td>string | null</td><td></td></tr>
          <tr><td><code>priority</code></td><td>enum</td><td></td></tr>
          <tr><td><code>status</code></td><td>enum</td><td></td></tr>
          <tr><td><code>labelIds</code></td><td>uuid[]</td><td>Replaces the existing label set.</td></tr>
          <tr><td><code>teamId</code></td><td>uuid</td><td>Move to another team.</td></tr>
          <tr><td><code>projectId</code></td><td>uuid | null</td><td>Move to another project, or detach.</td></tr>
          <tr><td><code>dueDate</code></td><td>ISO datetime | null</td><td>Clear with <code>null</code>.</td></tr>
          <tr><td><code>assigneeId</code></td><td>uuid | null</td><td>Assign / unassign.</td></tr>
          <tr><td><code>model</code></td><td>string | null</td><td>Preferred AI model.</td></tr>
        </tbody>
      </table>

      <h3>Example</h3>
      <CodeBlock language="json">{`{
  "tool": "openlinear_update_issue",
  "input": {
    "taskId": "...",
    "status": "in_progress",
    "assigneeId": "..."
  }
}`}</CodeBlock>

      <PageNav />
    </div>
  )
}
