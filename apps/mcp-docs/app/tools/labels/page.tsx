import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Label tools — OpenLinear MCP' }

export default function LabelsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Label tools</h1>
      <p>
        Labels are project-scoped tags applied to issues. OpenLinear uses labels to represent
        <strong> phases</strong>: a label named <code>phase:N &mdash; Name</code> bundles every issue in
        that phase. Plain non-phase labels work too &mdash; they&rsquo;re just tags.
      </p>

      <Callout variant="info">
        Labels live under a <em>project</em>, not a team or workspace. Two projects can have the same
        label name without conflict.
      </Callout>

      <h2 id="list">openlinear_list_labels</h2>
      <p>List every label on a project, including phase labels.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>projectId</code></td><td>uuid</td><td>Required.</td></tr>
        </tbody>
      </table>

      <h2 id="create">openlinear_create_label</h2>
      <p>Create a project-scoped label.</p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>projectId</code></td><td>uuid</td><td>Required.</td></tr>
          <tr><td><code>name</code></td><td>string (1&ndash;50)</td><td>Required.</td></tr>
          <tr><td><code>color</code></td><td>string</td><td><code>#RRGGBB</code>, required.</td></tr>
          <tr><td><code>priority</code></td><td>int &ge; 0</td><td>Display ordering. Optional.</td></tr>
        </tbody>
      </table>

      <h3>Example</h3>
      <CodeBlock language="json">{`{
  "tool": "openlinear_create_label",
  "input": {
    "projectId": "...",
    "name": "blocked",
    "color": "#E11D48",
    "priority": 100
  }
}`}</CodeBlock>

      <PageNav />
    </div>
  )
}
