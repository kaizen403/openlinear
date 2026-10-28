import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Bulk Create Plan — OpenLinear MCP' }

export default function BulkPlanPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>openlinear_bulk_create_plan</h1>
      <p className="text-lg text-foreground/85">
        The headline tool. Takes an entire AI-generated plan &mdash; project, phases, tasks &mdash; and creates
        everything in one call, then reports exactly what it created.
      </p>

      <Callout variant="tip" title="When to use this">
        Prefer <code>bulk_create_plan</code> whenever the model produces more than one or two tasks. It avoids the
        round-trip chatter of calling create_project, create_phase and create_issue separately.
      </Callout>

      <ToolReference name="openlinear_bulk_create_plan">
        <p>
          <code>phases[]</code> items take <code>name</code> (1&ndash;40 characters), an optional{' '}
          <code>color</code> and <code>tasks</code> (1&ndash;50 per phase), each with <code>title</code>, an optional
          markdown <code>description</code> and <code>priority</code> (<code>low | medium | high</code>, default
          medium). Unknown fields are rejected rather than silently ignored.
        </p>
      </ToolReference>

      <h2>What it does, step by step</h2>
      <ol>
        <li>
          Creates the project with <code>status: &quot;planned&quot;</code>; the project comes with its own default team,
          or adopts the existing team passed as <code>teamId</code> (see{' '}
          <a href="/tools/projects">adopting an existing team</a>; if the team cannot move, nothing is created).
        </li>
        <li>
          For phase N, finds or creates the label <code>phase:N &mdash; Name</code> (an existing label with that name is
          reused).
        </li>
        <li>
          Creates the phase&rsquo;s tasks as <code>todo</code> issues carrying that label, in batches that fit the
          API&rsquo;s request limits, phase by phase so issue numbers follow the plan.
        </li>
        <li>Returns the project, the team and, per phase, the label and the ids of every issue created.</li>
      </ol>

      <h2>Example</h2>
      <CodeBlock language="json">{`{
  "tool": "openlinear_bulk_create_plan",
  "input": {
    "project": { "name": "Stripe Billing Integration", "key": "BILL" },
    "phases": [
      { "name": "Foundation", "tasks": [
        { "title": "Create Stripe account & test API keys", "priority": "high" },
        { "title": "Add stripe SDK and config" } ] },
      { "name": "Checkout", "tasks": [
        { "title": "Pricing page UI" },
        { "title": "POST /api/billing/checkout-session" },
        { "title": "Webhook: handle checkout.session.completed" } ] }
    ]
  }
}`}</CodeBlock>

      <h2>Result</h2>
      <CodeBlock language="json">{`{
  "status": "complete",
  "summary": "Created project BILL (Stripe Billing Integration) with 2 phases and 5 issues.",
  "projectId": "…",
  "projectKey": "BILL",
  "projectName": "Stripe Billing Integration",
  "teamId": "…",
  "totalTasks": 5,
  "phases": [
    { "name": "Foundation", "number": 1, "labelId": "…", "labelName": "phase:1 — Foundation",
      "labelReused": false, "taskCount": 2, "taskIds": ["…", "…"], "replayed": false },
    { "name": "Checkout", "number": 2, "labelId": "…", "labelName": "phase:2 — Checkout",
      "labelReused": false, "taskCount": 3, "taskIds": ["…", "…", "…"], "replayed": false }
  ],
  "idempotency": { "key": "mcp1.plan.project.…", "replayed": false }
}`}</CodeBlock>

      <h2>Partial failures and retries</h2>
      <p>
        The call is not one transaction. If the project cannot be created, the tool returns an error and nothing
        exists. After that, every phase is attempted in order and the result says precisely what happened:
      </p>
      <ul>
        <li>
          <code>status: &quot;partial&quot;</code> and a <code>summary</code> starting with <code>PARTIAL</code> mean
          at least one phase failed.
        </li>
        <li>
          <code>phases[].error</code> explains why a phase (or the rest of it) was not created;{' '}
          <code>phases[].taskIds</code> still lists any issues that phase did create.
        </li>
        <li>
          <code>phases[].failed</code> lists individual tasks the API refused (index into that phase&rsquo;s tasks).
        </li>
        <li>After an authentication, scope or rate-limit failure the remaining phases are skipped.</li>
      </ul>
      <CodeBlock language="json">{`{
  "name": "Checkout",
  "number": 2,
  "labelId": "…",
  "labelName": "phase:2 — Checkout",
  "labelReused": false,
  "taskCount": 0,
  "taskIds": [],
  "error": "OpenLinear API error 503 (HTTP_503). Calling openlinear_bulk_create_plan again with identical arguments is safe."
}`}</CodeBlock>

      <Callout variant="success" title="Finish a partial plan by repeating the call">
        Call the tool again with <strong>identical arguments within 24 hours</strong>. Every write carries an{' '}
        <code>Idempotency-Key</code> derived from the arguments: the project and the completed phases are returned
        from the earlier call (<code>replayed: true</code>), existing phase labels are reused, and only the missing
        phases are created. No duplicates. After 24 hours the steps are no longer remembered and a repeat creates a
        new project.
      </Callout>

      <h2>Limits</h2>
      <ul>
        <li>Max <strong>10 phases</strong> per call and <strong>50 tasks</strong> per phase (500 tasks per call).</li>
        <li>Task descriptions up to 10&thinsp;000 characters; large phases are split into several API requests.</li>
        <li>The request body to the MCP server is capped at 2 MB.</li>
      </ul>

      <PageNav />
    </div>
  )
}
