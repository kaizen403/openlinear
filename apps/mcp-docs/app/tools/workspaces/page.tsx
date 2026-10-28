import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Workspace tools — OpenLinear MCP' }

export default function WorkspacesPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Workspace tools</h1>
      <p>
        Workspaces are the top-level tenant boundary in OpenLinear. Projects always live inside one. A token created
        for a single workspace only ever sees that workspace.
      </p>

      <ToolReference name="openlinear_list_workspaces">
        <h3>Returns</h3>
        <CodeBlock language="json">{`{
  "workspaces": [
    {
      "id": "0b6f3c1e-…",
      "name": "Acme",
      "slug": "acme",
      "plan": "free",
      "role": "owner",
      "memberCount": 4,
      "projectCount": 3
    }
  ]
}`}</CodeBlock>
        <h3>Example prompt</h3>
        <blockquote>&ldquo;What OpenLinear workspaces do I have?&rdquo;</blockquote>
      </ToolReference>

      <PageNav />
    </div>
  )
}
