import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Reviewable plans — OpenLinear MCP' }

export default function PlansPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Reviewable plans</h1>
      <p className="text-lg text-foreground/85">
        Propose a plan that people review in OpenLinear before anything is created: tasks with acceptance checks,
        estimates, risk and blockers. Approving the latest revision creates the issues; nothing runs by itself.
      </p>

      <Callout variant="tip" title="Plan or bulk create?">
        Use <code>openlinear_propose_plan</code> when a person should review the work first, and{' '}
        <code>openlinear_bulk_create_plan</code> when the user asked you to create the issues directly.
      </Callout>

      <h2>How a plan works</h2>
      <ul>
        <li>
          Every task has a <code>key</code> you choose (letters, digits, <code>.</code> <code>_</code>{' '}
          <code>-</code>). Keep keys stable across revisions: approval updates the issue a key created instead of
          creating another.
        </li>
        <li>
          <code>blockedBy</code> lists keys that must be done first. Duplicate keys, unknown blockers and loops are
          refused before anything is stored; tasks without acceptance checks or estimates are flagged for the reviewer.
        </li>
        <li>
          Revisions are immutable. <code>openlinear_revise_plan</code> sends the whole task list based on the latest
          revision; if someone revised it meanwhile you get <code>PLAN_REVISION_CONFLICT</code> — read it again.
        </li>
        <li>
          Approval (by a person in OpenLinear, or <code>openlinear_approve_plan</code> when the user asks) creates new
          issues with the acceptance checklist in their description, applies only what the plan changed since the
          last approval, keeps edits made on the issues, and syncs the blockers between them.
        </li>
      </ul>

      <ToolReference name="openlinear_list_plans" />
      <ToolReference name="openlinear_propose_plan">
        <CodeBlock language="json">{`{
  "projectId": "…",
  "title": "Ship login",
  "tasks": [
    { "key": "schema", "title": "Users table", "acceptance": ["Migration applies"], "estimate": "s" },
    { "key": "api", "title": "Login endpoint", "blockedBy": ["schema"], "risk": "medium" },
    { "key": "ui", "title": "Login form", "blockedBy": ["api"] }
  ]
}`}</CodeBlock>
      </ToolReference>
      <ToolReference name="openlinear_get_plan" />
      <ToolReference name="openlinear_revise_plan" />
      <ToolReference name="openlinear_approve_plan" />

      <PageNav />
    </div>
  )
}
