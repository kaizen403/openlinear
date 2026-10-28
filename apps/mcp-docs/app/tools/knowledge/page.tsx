import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Project knowledge — OpenLinear MCP' }

export default function KnowledgePage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Project knowledge</h1>
      <p className="text-lg text-foreground/85">
        The conventions, procedures and notes a team wants every agent run in a project to know — &ldquo;use pnpm,
        never npm&rdquo;, &ldquo;run the migration check before a PR&rdquo;. OpenLinear gives the active entries to each
        run in its first prompt.
      </p>

      <Callout variant="tip" title="People approve, agents propose">
        An MCP client can only <em>propose</em> knowledge. Nothing changes for agents until a person approves the
        proposal in OpenLinear (project → Knowledge), where entries are also edited, retracted and restored with their
        full history.
      </Callout>

      <h2>Using it</h2>
      <ul>
        <li>
          Call <code>openlinear_list_knowledge</code> before working in a project: active entries are what the team
          expects; proposals are still waiting for a person.
        </li>
        <li>
          Propose only when the user asks you to remember something, and write a general, lasting rule
          (<code>kind</code>: <code>convention</code>, <code>procedure</code> or <code>note</code>), not a one-off
          instruction.
        </li>
        <li>
          Runs are given at most 20 active, unexpired entries (8,000 characters), conventions first. A project keeps at
          most 200 entries.
        </li>
      </ul>

      <ToolReference name="openlinear_list_knowledge" />
      <ToolReference name="openlinear_propose_knowledge">
        <CodeBlock language="json">{`{
  "projectId": "…",
  "kind": "convention",
  "title": "Use pnpm, never npm or yarn",
  "body": "Install with pnpm install --ignore-scripts. Lockfile changes go in their own commit."
}`}</CodeBlock>
      </ToolReference>

      <PageNav />
    </div>
  )
}
