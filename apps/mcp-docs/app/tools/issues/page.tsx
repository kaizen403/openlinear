import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Issue tools — OpenLinear MCP' }

export default function IssuesPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Issue tools</h1>
      <p>
        Issues are the tasks OpenLinear&rsquo;s coding agents execute. Each belongs to a project and its team (which
        gives it an identifier such as <code>ENG-12</code>) and carries a status (<code>todo</code>,{' '}
        <code>in_progress</code>, <code>done</code>, <code>cancelled</code>), a priority, labels and an optional
        assignee. These tools let an agent find, read, create and manage them.
      </p>

      <h2>Finding issues</h2>

      <ToolReference name="openlinear_search" />

      <ToolReference name="openlinear_list_issues">
        <Callout variant="info" title="Exact, server-side filters">
          Every filter is applied by the OpenLinear API and they combine with AND, so results are exact whatever the
          size of the project. <code>labelId</code> takes one label or up to 20 (an issue matches if it has any of
          them); <code>parentId</code> lists the sub-issues of one issue, or top-level issues with{' '}
          <code>&quot;none&quot;</code>; <code>query</code> matches literally (<code>%</code> and <code>_</code> are
          not wildcards). The API ORs <code>assignee</code> with <code>creator</code>, so when you pass both the MCP
          server keeps the creator check on its side; such a page can then hold fewer than <code>limit</code> issues
          while <code>hasMore</code> is still true.
        </Callout>
        <h3>Paging</h3>
        <p>
          Results come newest first. When <code>hasMore</code> is true, call the tool again with the same filters and{' '}
          <code>cursor</code> set to the <code>nextCursor</code> you received. Cursors are opaque; issues created
          while you page never shift or repeat later pages. <code>total</code> is <code>null</code> unless you pass{' '}
          <code>includeTotal: true</code>.
        </p>
        <CodeBlock language="json">{`{
  "tool": "openlinear_list_issues",
  "input": { "projectId": "…", "assignee": "me", "status": ["todo", "in_progress"], "limit": 25 }
}

{
  "issues": [ { "id": "…", "identifier": "BILL-7", "title": "…", "status": "todo", "…": "…" } ],
  "limit": 25,
  "hasMore": true,
  "nextCursor": "eyJ2IjoxLCJjIjoi…",
  "total": null
}`}</CodeBlock>
      </ToolReference>

      <ToolReference name="openlinear_get_issue">
        <p>
          An identifier such as <code>ENG-12</code> is matched exactly and case-insensitively. Teams in different
          workspaces can share a key; an ambiguous identifier is refused with the candidate ids, and so is a lookup
          that could not read every match, even when it found only one (pass <code>taskId</code> then). The parent issue and
          up to 100 direct sub-issues come with the issue; <code>subtasks.complete</code> is false when that cap was
          reached (list them all with <code>openlinear_list_issues</code> and <code>parentId</code>).
        </p>
        <h3>Returns</h3>
        <CodeBlock language="json">{`{
  "issue": {
    "id": "…", "identifier": "BILL-3", "title": "Webhook: checkout.session.completed",
    "status": "in_progress", "priority": "high",
    "projectId": "…", "projectName": "Stripe Billing", "teamId": "…", "teamKey": "BILL",
    "assignee": { "id": "…", "username": "alice" },
    "labels": [{ "id": "…", "name": "phase:2 — Checkout", "color": "#10B981" }],
    "phase": { "number": 2, "name": "Checkout" },
    "parentId": "…", "dueDate": null, "prUrl": null,
    "description": "…", "creator": { "id": "…", "username": "alice" },
    "outcome": null, "model": null, "agent": null, "archived": false,
    "createdAt": "…", "updatedAt": "…"
  },
  "parent": { "id": "…", "identifier": "BILL-2", "title": "Checkout flow", "status": "in_progress" },
  "comments": { "items": [ { "id": "…", "body": "Started.", "author": { "id": "…", "username": "bob" },
                             "createdAt": "…", "updatedAt": "…" } ],
                "total": 1, "truncated": false },
  "subtasks": { "items": [ { "id": "…", "identifier": "BILL-9", "title": "Verify signature", "status": "todo" } ],
                "complete": true }
}`}</CodeBlock>
      </ToolReference>

      <h2>Creating and changing issues</h2>

      <ToolReference name="openlinear_find_similar_issues">
        <p>
          Call it before creating an issue: it returns open issues in the project whose title is similar (trigram
          similarity, best first), so you can comment on or update an existing issue instead of filing a duplicate.
        </p>
      </ToolReference>

      <ToolReference name="openlinear_create_issue">
        <Callout variant="success" title="Safe to retry">
          The server sends an <code>Idempotency-Key</code> derived from the arguments, so repeating an identical call
          within 24 hours returns the original issue with <code>idempotency.replayed: true</code> instead of creating
          a duplicate. See <a href="/guides/troubleshooting#retries">retries</a>.
        </Callout>
        <CodeBlock language="json">{`{
  "tool": "openlinear_create_issue",
  "input": {
    "projectId": "…",
    "title": "Add JWT refresh endpoint",
    "description": "POST /api/auth/refresh returning a new short-lived token.",
    "priority": "high",
    "labelIds": ["<phase label id>"],
    "assigneeIds": ["me", "<teammate user id>"]
  }
}`}</CodeBlock>
        <p>
          <code>assigneeIds</code> must be members of the issue&rsquo;s team (<code>openlinear_list_teams</code> lists
          them); the first one is the primary assignee shown on the board. With only <code>teamId</code> the issue has
          no project, and issues without a project take no labels.
        </p>
      </ToolReference>

      <ToolReference name="openlinear_update_issue">
        <Callout variant="warning" title="labelIds replaces">
          <code>labelIds</code> replaces the whole label set. To add or remove single labels, use{' '}
          <code>openlinear_label_issue</code>.
        </Callout>
      </ToolReference>

      <ToolReference name="openlinear_assign_issue" />

      <ToolReference name="openlinear_label_issue">
        <p>
          Each label is attached or detached with its own API call, so labels someone else changes at the same time
          are never overwritten. Labels already attached (or already absent) are skipped and left out of <code>added</code> /{' '}
          <code>removed</code>. A
          label from another project is refused with <code>LABEL_NOT_IN_TASK_PROJECT</code>; additions run first, so
          a refused call has removed nothing.
        </p>
      </ToolReference>

      <ToolReference name="openlinear_bulk_update_status">
        <p>
          Pass exactly one scope: <code>projectId</code> for issues of a project, or <code>teamId</code> for a
          team&rsquo;s issues that have no project. Listed issues outside the scope are reported in{' '}
          <code>failed</code> and left unchanged. The explicit list of 1&ndash;100 ids is always required.
        </p>
        <CodeBlock language="json">{`{
  "status": "done",
  "updated": [{ "id": "…", "identifier": "BILL-1", "title": "Stripe keys" }],
  "unchanged": [],
  "failed": []
}`}</CodeBlock>
      </ToolReference>

      <ToolReference name="openlinear_add_comment" />

      <h2>Blockers</h2>

      <ToolReference name="openlinear_set_blockers">
        <Callout variant="info" title="What blocked means">
          An issue blocked by another waits until that one is <code>done</code> (cancelled still blocks: a failed agent
          run ends as cancelled). Agent runs of a blocked issue are refused unless the user runs it anyway, and batches
          run blockers first. Blockers must be in the same project, and loops are refused (
          <code>DEPENDENCY_CYCLE</code>). <code>openlinear_get_issue</code> returns <code>blockedBy</code> and{' '}
          <code>blocking</code>.
        </Callout>
      </ToolReference>

      <PageNav />
    </div>
  )
}
