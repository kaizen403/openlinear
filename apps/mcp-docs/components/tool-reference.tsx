import { getTool, type ToolEntry } from '@/lib/tool-catalog'
import { cn } from '@/lib/cn'

function Badge({ children, tone }: { children: React.ReactNode; tone: 'green' | 'amber' | 'red' | 'sky' | 'muted' }) {
  const tones = {
    green: 'border-emerald-500/30 bg-emerald-500/[0.06] text-emerald-300',
    amber: 'border-amber-500/30 bg-amber-500/[0.06] text-amber-200',
    red: 'border-rose-500/30 bg-rose-500/[0.06] text-rose-300',
    sky: 'border-sky-500/30 bg-sky-500/[0.06] text-sky-300',
    muted: 'border-white/10 bg-white/[0.03] text-muted-foreground',
  }
  return <span className={cn('rounded-full border px-2.5 py-0.5 text-xs', tones[tone])}>{children}</span>
}

export function ToolBadges({ tool }: { tool: ToolEntry }) {
  const { readOnlyHint, destructiveHint, idempotentHint } = tool.annotations
  return (
    <div className="not-prose my-3 flex flex-wrap gap-2">
      {readOnlyHint ? <Badge tone="green">read-only</Badge> : <Badge tone="amber">writes</Badge>}
      {!readOnlyHint && destructiveHint && <Badge tone="red">overwrites data</Badge>}
      {!readOnlyHint && (idempotentHint ? <Badge tone="sky">safe to retry</Badge> : <Badge tone="muted">not idempotent</Badge>)}
      <Badge tone="muted">token scope: {tool.scopes.join(' or ')}</Badge>
    </div>
  )
}

function formatDefault(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Reference block for one tool, rendered from the generated catalogue. */
export function ToolReference({ name, children }: { name: string; children?: React.ReactNode }) {
  const tool = getTool(name)
  return (
    <section>
      <h2 id={tool.name.replace(/^openlinear_/, '')}>
        <code>{tool.name}</code>
      </h2>
      <p>{tool.description}</p>
      <ToolBadges tool={tool} />
      <h3>Input</h3>
      {tool.inputs.length === 0 ? (
        <p>
          <em>None.</em>
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {tool.inputs.map((input) => (
              <tr key={input.name}>
                <td>
                  <code>{input.name}</code>
                  {input.required ? ' *' : ''}
                </td>
                <td>{input.type}</td>
                <td>
                  {input.description}
                  {input.default !== undefined ? ` (default: ${formatDefault(input.default)})` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {children}
    </section>
  )
}
