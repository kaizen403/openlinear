import { ToolCard } from '@/components/tool-card'
import { PageNav } from '@/components/page-nav'
import { Callout } from '@/components/callout'
import { getTool, TOOL_COUNT, TOOL_GROUPS } from '@/lib/tool-catalog'

export const metadata = { title: 'Tools — OpenLinear MCP' }

export default function ToolsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Tools reference</h1>
      <p>
        OpenLinear MCP exposes {TOOL_COUNT} tools: read your workspaces, projects, teams, labels and issues; plan work
        with <code>openlinear_bulk_create_plan</code> or propose a plan people review first; and manage it by updating,
        assigning, labelling, ordering (blockers), moving and commenting on issues. This list is generated from the live
        server, so it always matches what your client sees.
      </p>

      <Callout variant="info" title="Hints your client can use">
        Every tool declares MCP annotations: <code>readOnlyHint</code>, <code>destructiveHint</code>,{' '}
        <code>idempotentHint</code> and <code>openWorldHint</code> (always false: tools only touch your own OpenLinear
        data). Every tool also returns <code>structuredContent</code> matching its <code>outputSchema</code>, with the
        same JSON in a text block.
      </Callout>

      <h2>By domain</h2>

      <div className="not-prose grid gap-3">
        {TOOL_GROUPS.map((group) => (
          <div key={group.title}>
            <h3 className="mb-2 font-display text-base font-semibold text-white">{group.title}</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.tools.map((name) => {
                const tool = getTool(name)
                return (
                  <ToolCard
                    key={name}
                    name={name}
                    href={`${group.href}#${name.replace(/^openlinear_/, '')}`}
                    description={`${tool.annotations.readOnlyHint ? 'Read-only. ' : ''}${tool.title}.`}
                  />
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <PageNav />
    </div>
  )
}
