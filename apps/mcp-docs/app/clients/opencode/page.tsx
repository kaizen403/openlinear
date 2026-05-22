import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'OpenCode — OpenLinear MCP' }

export default function OpenCodePage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>OpenCode</h1>
      <p>
        OpenCode is a terminal-based coding agent. It loads MCP servers from
        <code>~/.config/opencode/opencode.json</code> (or the project-local <code>./.opencode/opencode.json</code>).
      </p>

      <h2>Configuration</h2>
      <CodeBlock language="json" filename="opencode.json">{`{
  "mcp": {
    "openlinear": {
      "type": "remote",
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": {
        "Authorization": "Bearer ol_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}`}</CodeBlock>

      <h2>Use it in a session</h2>
      <p>
        Start an OpenCode session in any repository. The agent now has access to all 12 OpenLinear tools.
        Try:
      </p>
      <blockquote>
        &ldquo;Use openlinear to plan the execution workflow for refactoring the auth module. Phases:
        audit, migration, cleanup.&rdquo;
      </blockquote>
      <p>
        OpenCode will call <code>openlinear_bulk_create_plan</code> and report the project key and task
        IDs. Pop over to your OpenLinear dashboard &mdash; the project is there, ready to execute.
      </p>

      <h2>OpenLinear &times; OpenCode loop</h2>
      <p>
        This is the canonical workflow: use OpenCode to <em>plan</em> in OpenLinear via MCP, then click
        <strong>Execute</strong> on each task in OpenLinear &mdash; which spawns an OpenCode agent that
        opens a real PR. Plan once, execute many.
      </p>

      <PageNav />
    </div>
  )
}
