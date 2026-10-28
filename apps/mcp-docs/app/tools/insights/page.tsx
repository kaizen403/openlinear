import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Insights — OpenLinear MCP' }

export default function InsightsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Insights</h1>
      <p className="text-lg text-foreground/85">
        How agent work and delivery are going in a project, or across the projects of a workspace you can read, over
        the last 7, 30 or 90 days — the same numbers as the Insights page in OpenLinear.
      </p>

      <h2>What it reports</h2>
      <ul>
        <li>
          <strong>Agent runs</strong> started in the range: succeeded, failed, cancelled, needs recovery (the run&rsquo;s
          state was lost; work may remain on the device) and in progress. Success, verification pass and pull request
          rates are over finished runs.
        </li>
        <li>Median and p90 run duration, from the claim to the end of the run.</li>
        <li>Known cost and tokens, by runner and by model (the ten busiest, then &ldquo;(other)&rdquo;).</li>
        <li>
          <strong>Delivery</strong>: issues created and completed (by their last move to done), cycle time, issues blocked
          right now and plan approvals.
        </li>
      </ul>

      <Callout variant="info" title="Unknown prices stay unknown">
        <code>knownUsd</code> sums recorded costs only. Finished runs without a recorded price are counted in{' '}
        <code>unknownCostRuns</code> and never as $0 — say so when you report a cost. The <code>notes</code> field
        explains each number that could be read two ways.
      </Callout>

      <h2>Using it</h2>
      <ul>
        <li>
          Pass exactly one of <code>projectId</code> or <code>workspaceId</code>. A workspace leaves out projects that
          deny you.
        </li>
        <li>
          Daily points (one per UTC day, today last) are only returned with <code>includeDaily: true</code>, to keep
          answers short.
        </li>
      </ul>

      <ToolReference name="openlinear_get_insights">
        <CodeBlock language="json">{`{
  "projectId": "…",
  "range": "7d"
}`}</CodeBlock>
      </ToolReference>

      <PageNav />
    </div>
  )
}
