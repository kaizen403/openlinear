import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Plan from a prompt — OpenLinear MCP' }

export default function PlanFromPromptPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Plan a project from a prompt</h1>
      <p>
        This is the workflow OpenLinear MCP was built for: describe a project in natural language, let
        the model structure it into phases and tasks, and watch a fully populated dashboard appear in
        OpenLinear &mdash; one click away from being executed.
      </p>

      <h2>1. Frame the request</h2>
      <p>Tell the model the shape of the output it should produce. A solid prompt:</p>
      <blockquote>
        &ldquo;Use OpenLinear to plan an end-to-end &ldquo;Stripe billing&rdquo; project. Break it into
        4&ndash;6 phases. Each phase should have 3&ndash;8 atomic engineering tasks (one PR each).
        Use <code>openlinear_bulk_create_plan</code> with my default workspace.&rdquo;
      </blockquote>

      <h2>2. Let the model draft</h2>
      <p>
        Good models will outline phases first, then list tasks per phase, then call the tool. If yours
        jumps straight to the tool call, that&rsquo;s fine &mdash; you&rsquo;ll see the plan in the
        OpenLinear dashboard afterwards.
      </p>

      <Callout variant="tip" title="Keep tasks atomic">
        Each task in OpenLinear becomes a unit that an AI agent will execute and open a PR for. Push the
        model toward small, single-PR tasks: &ldquo;Add the webhook handler&rdquo;, not &ldquo;Build
        billing&rdquo;.
      </Callout>

      <h2>3. Inspect the result</h2>
      <p>The tool returns a summary like:</p>
      <CodeBlock language="json">{`{
  "projectKey": "BILL",
  "totalTasks": 19,
  "phases": [
    { "name": "Foundation", "taskCount": 4, "taskIds": [...] },
    { "name": "Checkout", "taskCount": 5, "taskIds": [...] },
    ...
  ]
}`}</CodeBlock>
      <p>
        Open <a href="https://openlinear.tech">openlinear.tech</a>, switch to the new project, and group
        by phase label. You&rsquo;ll see every task bucketed under <code>phase:1 &mdash; Foundation</code>,
        <code>phase:2 &mdash; Checkout</code>, and so on.
      </p>

      <h2>4. Execute</h2>
      <p>
        For each task, click <strong>Execute</strong>. OpenLinear spawns an OpenCode agent in your
        repository, the agent works through the task description, and you get a real pull request to
        review.
      </p>

      <h2>Worked example prompts</h2>
      <h3>Greenfield feature</h3>
      <blockquote>
        &ldquo;Plan a multi-tenant audit log feature in OpenLinear. 3 phases: schema + writes, query
        API, admin UI. Include rough acceptance criteria in each task description.&rdquo;
      </blockquote>

      <h3>Migration</h3>
      <blockquote>
        &ldquo;Use OpenLinear to plan a Postgres 14 &rarr; 16 upgrade for a multi-region cluster. Phases:
        prep + dry-run, dual-write, cutover, cleanup. Mark cutover tasks high priority.&rdquo;
      </blockquote>

      <h3>Refactor</h3>
      <blockquote>
        &ldquo;I want to extract <code>apps/api/src/routes/tasks.ts</code> into a service layer. Plan it
        in OpenLinear with 3 phases (extract pure functions, wire controllers, delete legacy paths) and
        one PR per task.&rdquo;
      </blockquote>

      <PageNav />
    </div>
  )
}
