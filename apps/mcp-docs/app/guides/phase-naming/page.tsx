import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Phase naming convention — OpenLinear MCP' }

export default function PhaseNamingPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Phase naming convention</h1>
      <p>
        Phases in OpenLinear are <strong>just labels</strong> with a consistent name prefix. This page
        documents the exact format so you can produce or parse phase labels in your own tooling.
      </p>

      <h2>The format</h2>
      <CodeBlock language="text">{`phase:<N> — <Name>`}</CodeBlock>
      <ul>
        <li><code>phase:</code> &mdash; literal prefix, lowercase.</li>
        <li><code>&lt;N&gt;</code> &mdash; integer 1&ndash;100, no leading zeros, no padding.</li>
        <li> <code>&mdash;</code> &mdash; an em dash (U+2014) with a single space on each side.</li>
        <li><code>&lt;Name&gt;</code> &mdash; 1&ndash;40 characters, any unicode.</li>
      </ul>

      <h3>Examples</h3>
      <ul>
        <li><code>phase:1 &mdash; Foundation</code></li>
        <li><code>phase:2 &mdash; Onboarding flow</code></li>
        <li><code>phase:10 &mdash; Hardening</code></li>
      </ul>

      <Callout variant="warning" title="The em dash matters">
        OpenLinear&rsquo;s dashboard groups phases by exact-match on the <code>phase:N &mdash; </code>
        prefix. A regular hyphen or different spacing won&rsquo;t group.
      </Callout>

      <h2>Why labels, not a phase model</h2>
      <p>
        Labels already exist in OpenLinear, with filtering, grouping, colours, and ordering. Adding a
        dedicated <code>Phase</code> table would mean migrations, new APIs, UI work, and a model that
        99% overlaps with labels. The convention is the contract.
      </p>

      <h2>Parsing in your code</h2>
      <p>If you&rsquo;re building tooling on top:</p>
      <CodeBlock language="typescript">{`const PHASE_RE = /^phase:(\\d{1,3}) — (.+)$/

function parsePhase(label: string) {
  const m = PHASE_RE.exec(label)
  if (!m) return null
  return { number: Number(m[1]), name: m[2] }
}`}</CodeBlock>

      <h2>Colours</h2>
      <p>
        The MCP server uses a fixed ten-colour palette when you don&rsquo;t supply
        <code>phases[].color</code>:
      </p>
      <CodeBlock language="typescript">{`const DEFAULT_PHASE_COLORS = [
  '#3B82F6', // blue
  '#10B981', // emerald
  '#F59E0B', // amber
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#06B6D4', // cyan
  '#F97316', // orange
  '#6366F1', // indigo
  '#14B8A6', // teal
  '#E11D48', // rose
]`}</CodeBlock>

      <PageNav />
    </div>
  )
}
