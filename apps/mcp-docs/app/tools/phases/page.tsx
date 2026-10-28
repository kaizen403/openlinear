import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Phase tools — OpenLinear MCP' }

const colors = [
  '#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899',
  '#06B6D4', '#F97316', '#6366F1', '#14B8A6', '#E11D48',
]

export default function PhasesPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Phase tools</h1>
      <p>
        Phases aren&rsquo;t a separate data model in OpenLinear &mdash; they&rsquo;re a labelling{' '}
        <strong>convention</strong>. A phase is a label named <code>phase:N &mdash; Name</code> (e.g.{' '}
        <code>phase:1 &mdash; Foundation</code>). Every issue in that phase carries that label.
      </p>

      <Callout variant="tip" title="Listing phases">
        <code>openlinear_list_labels</code> with <code>phasesOnly: true</code> lists a project&rsquo;s phases in
        order; <code>openlinear_list_issues</code> with <code>labelId</code> lists the issues of one phase.
      </Callout>

      <ToolReference name="openlinear_create_phase">
        <h3>Default colour palette</h3>
        <p>Without a colour, the phase number picks one from this ten-colour cycle:</p>
        <div className="not-prose my-4 grid grid-cols-5 gap-2 sm:grid-cols-10">
          {colors.map((c) => (
            <div key={c} className="text-center">
              <div className="mb-1 h-8 w-full rounded-md border border-white/10" style={{ background: c }} />
              <div className="font-mono text-[10px] text-muted-foreground">{c}</div>
            </div>
          ))}
        </div>
        <h3>Result</h3>
        <CodeBlock language="json">{`{
  "label": {
    "id": "…",
    "name": "phase:2 — Onboarding",
    "color": "#10B981",
    "priority": 1,
    "phase": { "number": 2, "name": "Onboarding" }
  },
  "created": true
}`}</CodeBlock>
      </ToolReference>

      <PageNav />
    </div>
  )
}
