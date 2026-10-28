import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Label tools — OpenLinear MCP' }

export default function LabelsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Label tools</h1>
      <p>
        Labels are project-scoped tags applied to issues. OpenLinear uses labels to represent <strong>phases</strong>: a
        label named <code>phase:N &mdash; Name</code> bundles every issue in that phase.
      </p>

      <Callout variant="info">
        Label names are unique within a project. Creating a label that already exists returns the existing label with{' '}
        <code>created: false</code>, so label and phase creation are safe to retry.
      </Callout>

      <ToolReference name="openlinear_list_labels">
        <h3>Returns</h3>
        <CodeBlock language="json">{`{
  "labels": [
    { "id": "…", "name": "phase:1 — Foundation", "color": "#3B82F6", "priority": 0,
      "phase": { "number": 1, "name": "Foundation" } },
    { "id": "…", "name": "Bug", "color": "#ef4444", "priority": 5, "phase": null }
  ]
}`}</CodeBlock>
      </ToolReference>

      <ToolReference name="openlinear_create_label">
        <CodeBlock language="json">{`{
  "tool": "openlinear_create_label",
  "input": { "projectId": "…", "name": "blocked", "color": "#E11D48", "priority": 100 }
}`}</CodeBlock>
      </ToolReference>

      <PageNav />
    </div>
  )
}
