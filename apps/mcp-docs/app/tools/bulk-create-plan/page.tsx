import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Bulk Create Plan — OpenLinear MCP' }

export default function BulkPlanPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>openlinear_bulk_create_plan</h1>
      <p className="text-lg text-foreground/85">
        The headline tool. Takes an entire AI-generated plan &mdash; project, phases, tasks &mdash;
        and creates everything in one call. Auto-creates a team if needed. Returns IDs you can deep-link
        back to.
      </p>

      <Callout variant="tip" title="When to use this">
        Prefer <code>bulk_create_plan</code> any time the model is producing more than one or two tasks.
        It&rsquo;s atomic per phase, returns partial-success details on failure, and avoids the round-trip
        chatter of calling create_project + create_label + create_issue separately.
      </Callout>

      <h2>Input</h2>
      <table>
        <thead><tr><th>Field</th><th>Type</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td><code>workspaceId</code></td><td>string (optional)</td><td>Defaults to your default workspace.</td></tr>
          <tr><td><code>teamId</code></td><td>uuid (optional)</td><td>Existing team to attach. Auto-created if omitted.</td></tr>
          <tr><td><code>project.name</code></td><td>string (1&ndash;100)</td><td>Required.</td></tr>
          <tr><td><code>project.description</code></td><td>string (max 1000)</td><td>Optional.</td></tr>
          <tr><td><code>project.key</code></td><td>string</td><td>2&ndash;12 chars, must start with a letter; auto-generated if omitted.</td></tr>
          <tr><td><code>phases</code></td><td>array (1&ndash;10)</td><td>Ordered list of phases.</td></tr>
          <tr><td><code>phases[].name</code></td><td>string (1&ndash;40)</td><td>Required.</td></tr>
          <tr><td><code>phases[].description</code></td><td>string (max 500)</td><td>Optional.</td></tr>
          <tr><td><code>phases[].color</code></td><td>string</td><td><code>#RRGGBB</code>. Falls back to a default palette.</td></tr>
          <tr><td><code>phases[].tasks</code></td><td>array (1&ndash;50)</td><td>Tasks in this phase.</td></tr>
          <tr><td><code>phases[].tasks[].title</code></td><td>string (1&ndash;500)</td><td>Required.</td></tr>
          <tr><td><code>phases[].tasks[].description</code></td><td>string (max 10000)</td><td>Markdown supported.</td></tr>
          <tr><td><code>phases[].tasks[].priority</code></td><td>enum</td><td><code>low | medium | high</code> (default: medium)</td></tr>
        </tbody>
      </table>

      <h2>What it does, step by step</h2>
      <ol>
        <li>Creates the project with <code>status: &quot;planned&quot;</code>.</li>
        <li>Resolves the team: uses the project&rsquo;s existing team, or creates one named <code>&lt;Project&gt; Team</code> with key derived from the project key.</li>
        <li>For each phase, creates a label named <code>phase:N &mdash; Name</code> with the chosen colour and priority <code>N&minus;1</code>.</li>
        <li>For each phase, bulk-inserts all tasks against that phase&rsquo;s label, with <code>status: &quot;todo&quot;</code>.</li>
        <li>Returns a summary with the project ID, project key, total task count, and per-phase IDs.</li>
      </ol>

      <h2>Example</h2>
      <CodeBlock language="json">{`{
  "tool": "openlinear_bulk_create_plan",
  "input": {
    "project": {
      "name": "Stripe Billing Integration",
      "description": "Add subscription billing via Stripe Checkout.",
      "key": "BILL"
    },
    "phases": [
      {
        "name": "Foundation",
        "color": "#3B82F6",
        "tasks": [
          { "title": "Create Stripe account & test API keys", "priority": "high" },
          { "title": "Add stripe SDK and config" }
        ]
      },
      {
        "name": "Checkout",
        "color": "#10B981",
        "tasks": [
          { "title": "Pricing page UI" },
          { "title": "POST /api/billing/checkout-session" },
          { "title": "Webhook: handle checkout.session.completed" }
        ]
      },
      {
        "name": "Portal & cleanup",
        "tasks": [
          { "title": "Customer portal link" },
          { "title": "Cancel-subscription flow" }
        ]
      }
    ]
  }
}`}</CodeBlock>

      <h2>Result</h2>
      <CodeBlock language="json">{`{
  "projectId": "...",
  "projectKey": "BILL",
  "projectName": "Stripe Billing Integration",
  "totalTasks": 7,
  "phases": [
    {
      "name": "Foundation",
      "labelId": "label_...",
      "labelName": "phase:1 — Foundation",
      "taskCount": 2,
      "taskIds": ["task_...", "task_..."]
    },
    {
      "name": "Checkout",
      "labelId": "label_...",
      "labelName": "phase:2 — Checkout",
      "taskCount": 3,
      "taskIds": ["task_...", "task_...", "task_..."]
    },
    {
      "name": "Portal & cleanup",
      "labelId": "label_...",
      "labelName": "phase:3 — Portal & cleanup",
      "taskCount": 2,
      "taskIds": ["task_...", "task_..."]
    }
  ]
}`}</CodeBlock>

      <h2>Partial failures</h2>
      <p>
        Each phase is wrapped in its own try/catch. If one phase&rsquo;s bulk insert fails, the others
        still complete and the result includes the error on the failed phase:
      </p>
      <CodeBlock language="json">{`{
  "name": "Checkout",
  "labelId": "label_...",
  "labelName": "phase:2 — Checkout",
  "taskCount": 0,
  "taskIds": [],
  "failed": true,
  "error": "Task description exceeds 10000 characters"
}`}</CodeBlock>

      <p>
        Inspect <code>failed</code> on each phase and retry only those. The project, team, and successful
        phases stay intact.
      </p>

      <h2>Limits</h2>
      <ul>
        <li>Max <strong>10 phases</strong> per call.</li>
        <li>Max <strong>50 tasks</strong> per phase &rarr; <strong>500 tasks total</strong> per call.</li>
        <li>Project key must be 2&ndash;12 characters; team key derives from it (max 10).</li>
      </ul>

      <Callout variant="success" title="Idempotency tip">
        If a call fails halfway, you can retry safely by passing the existing <code>teamId</code> in the
        next attempt &mdash; MCP will reuse it rather than creating a new one. Phase labels with the same
        <code>phase:N</code> prefix collide, so delete the partially-created project first if you want a
        clean retry.
      </Callout>

      <PageNav />
    </div>
  )
}
