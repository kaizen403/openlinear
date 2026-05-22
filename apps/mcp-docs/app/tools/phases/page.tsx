import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Phase tools — OpenLinear MCP' }

export default function PhasesPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Phase tools</h1>
      <p>
        Phases aren&rsquo;t a separate data model in OpenLinear &mdash; they&rsquo;re a labelling
        <strong> convention</strong>. A phase is a label named <code>phase:N &mdash; Name</code> (e.g.
        <code>phase:1 &mdash; Foundation</code>). Every issue in that phase carries that label.
      </p>

      <Callout variant="tip" title="Why this works">
        Phases-as-labels mean every existing label filter, group, and report just works. No special
        schema, no migrations, no breakage. The convention is a contract between the MCP server and
        the dashboard&rsquo;s phase grouping UI.
      </Callout>

      <h2 id="create">openlinear_create_phase</h2>
      <p>
        Create a phase label using the naming convention. This is a thin sugar over
        <code>openlinear_create_label</code> &mdash; it constructs the <code>phase:N &mdash; Name</code>
        string for you.
      </p>

      <h3>Input</h3>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>projectId</code></td><td>uuid</td><td>Required.</td></tr>
          <tr><td><code>phaseNumber</code></td><td>int 1&ndash;100</td><td>Used to build the label name.</td></tr>
          <tr><td><code>name</code></td><td>string (1&ndash;40)</td><td>Phase display name.</td></tr>
          <tr><td><code>color</code></td><td>string</td><td><code>#RRGGBB</code>. Optional &mdash; cycles through a default palette.</td></tr>
        </tbody>
      </table>

      <h3>Default colour palette</h3>
      <p>If you don&rsquo;t pass a colour, MCP picks from this ten-colour cycle:</p>
      <div className="not-prose my-4 grid grid-cols-5 gap-2 sm:grid-cols-10">
        {colors.map((c) => (
          <div key={c} className="text-center">
            <div className="mb-1 h-8 w-full rounded-md border border-white/10" style={{ background: c }} />
            <div className="font-mono text-[10px] text-muted-foreground">{c}</div>
          </div>
        ))}
      </div>

      <h3>Example</h3>
      <CodeBlock language="json">{`{
  "tool": "openlinear_create_phase",
  "input": {
    "projectId": "...",
    "phaseNumber": 2,
    "name": "Onboarding",
    "color": "#10B981"
  }
}`}</CodeBlock>

      <h3>Result</h3>
      <CodeBlock language="json">{`{
  "id": "label_...",
  "name": "phase:2 — Onboarding",
  "color": "#10B981"
}`}</CodeBlock>

      <PageNav />
    </div>
  )
}

const colors = [
  '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
  '#06B6D4', '#F97316', '#6366F1', '#14B8A6', '#E11D48',
]
