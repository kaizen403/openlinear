import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Workspace tools — OpenLinear MCP' }

export default function WorkspacesPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Workspace tools</h1>
      <p>
        Workspaces are the top-level tenant boundary in OpenLinear. Every user has a default workspace
        created on first login; projects always live inside one.
      </p>

      <h2 id="list">openlinear_list_workspaces</h2>
      <p>List every workspace your token can access. Useful for picking a target workspace before
        creating a project.</p>

      <h3>Input</h3>
      <p><em>None.</em></p>

      <h3>Returns</h3>
      <CodeBlock language="json">{`{
  "count": 2,
  "workspaces": [
    {
      "id": "workspace-aeb35ae41ef68718e82d59f45ad0c447",
      "name": "kaizen403's Workspace",
      "slug": "kaizen403s-workspace",
      "plan": "free",
      "memberCount": 1,
      "projectCount": 0
    }
  ]
}`}</CodeBlock>

      <h3>Example prompt</h3>
      <blockquote>&ldquo;What OpenLinear workspaces do I have?&rdquo;</blockquote>

      <PageNav />
    </div>
  )
}
