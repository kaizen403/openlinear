import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Troubleshooting — OpenLinear MCP' }

export default function TroubleshootingPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Troubleshooting</h1>
      <p>Most issues fall into four buckets: auth, transport, validation, or domain rules. Work top-down.</p>

      <h2>1. Health check first</h2>
      <CodeBlock language="bash">{`curl https://mcp.openlinear.tech/healthz`}</CodeBlock>
      <p>
        Expect <code>{`{"ok":true,"ts":…,"name":"openlinear","version":"…"}`}</code>. If this fails, the server is down.
      </p>

      <h2>2. <code>401 Unauthorized</code></h2>
      <ul>
        <li>The token doesn&rsquo;t match <code>ol_pat_</code> + 32 lowercase hex characters, or was pasted with extra characters.</li>
        <li>The token was revoked or has expired. Create a new one in <strong>Settings &rarr; Personal Access Tokens</strong>.</li>
        <li>The header must be <code>Authorization: Bearer ol_pat_…</code>.</li>
      </ul>
      <CodeBlock language="bash">{`# Quick auth check: 200 means the token works
curl -s -o /dev/null -w "%{http_code}\\n" https://mcp.openlinear.tech/mcp \\
  -H "Authorization: Bearer ol_pat_xxx" -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'`}</CodeBlock>

      <h2>3. A tool says the token lacks a scope</h2>
      <p>
        <code>read</code> covers every read tool and <code>write</code> covers every tool. Narrow scopes cover one
        family each (<code>tasks:*</code> for issues and comments, <code>projects:*</code> for projects and teams,{' '}
        <code>labels:write</code> for labels and phases); see <a href="/authentication">Authentication</a>. The error
        names the scopes the tool needs and the scope the API asked for. Create a token with one of them.
      </p>
      <p>
        <code>&quot;me&quot; cannot be used … with this token</code> means the token has only narrow scopes, which do
        not include reading its owner: pass your user id instead (<code>openlinear_list_teams</code> lists members).
        Filters such as <code>assignee: &quot;me&quot;</code> in <code>openlinear_list_issues</code> still work.
      </p>

      <h2>4. Client can&rsquo;t find the server</h2>
      <ul>
        <li>Restart the client after editing the config &mdash; most clients only read MCP config at start-up.</li>
        <li>Check the JSON syntax; a missing comma can drop the whole <code>mcpServers</code> block.</li>
        <li>The client must support remote servers over Streamable HTTP; for stdio-only clients use the <code>mcp-remote</code> bridge shown under <a href="/clients/claude-desktop">Claude Desktop</a>.</li>
      </ul>

      <h2>5. A tool call returns a validation error</h2>
      <p>
        Arguments are checked against each tool&rsquo;s input schema before anything is written. Unknown field names
        are rejected (not ignored), ids must be UUIDs from earlier results (workspace ids are UUIDs too), and dates must
        be ISO 8601 UTC such as <code>2026-11-01T00:00:00Z</code>. The error names the offending field.
      </p>

      <h2 id="retries">6. A call timed out or failed halfway</h2>
      <p>
        <code>openlinear_create_issue</code>, <code>openlinear_bulk_create_plan</code>, <code>openlinear_create_project</code>,{' '}
        <code>openlinear_create_team</code>, <code>openlinear_create_label</code> and <code>openlinear_create_phase</code>{' '}
        are safe to repeat with <strong>identical arguments</strong>: the server derives an <code>Idempotency-Key</code>{' '}
        from them and the earlier result is returned (<code>replayed: true</code>) instead of a duplicate. Issue,
        project, team and plan creation is remembered for 24 hours. <code>openlinear_label_issue</code>,{' '}
        <code>openlinear_assign_issue</code>, <code>openlinear_update_issue</code> and{' '}
        <code>openlinear_bulk_update_status</code> are safe to repeat too: they set a state rather than add one.
      </p>
      <p>
        <code>openlinear_add_comment</code> is not idempotent: check the issue with <code>openlinear_get_issue</code>{' '}
        before repeating it.
      </p>

      <h2>7. <code>bulk_create_plan</code> returned <code>status: &quot;partial&quot;</code></h2>
      <p>
        Read <code>summary</code> and each <code>phases[].error</code> / <code>phases[].failed</code>: they say exactly
        what was and wasn&rsquo;t created. Repeat the call with identical arguments within 24 hours to create only the
        missing parts. See <a href="/tools/bulk-create-plan">Bulk Create Plan</a>.
      </p>

      <h2>8. Other errors</h2>
      <table>
        <thead><tr><th>Message</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td>Access denied / Not found</td><td>The id is wrong, or your role, project access or a workspace-bound token does not reach it.</td></tr>
          <tr><td>PAT_WORKSPACE_RESTRICTED</td><td>The token is bound to one workspace; use ids from that workspace.</td></tr>
          <tr><td>TEAM_PROJECT_CONFLICT</td><td>The team passed as <code>teamId</code>/<code>teamIds</code> cannot move into the new project; the message gives the reason per team (see <a href="/tools/projects">Projects</a>). Nothing was created. Omit the team to get a default one.</td></tr>
          <tr><td>LABEL_NOT_IN_TASK_PROJECT</td><td>The label belongs to another project than the issue, or the issue has no project. Use a label of the issue&rsquo;s project.</td></tr>
          <tr><td>INVALID_CURSOR</td><td>Pass <code>nextCursor</code> back exactly as returned, with the same filters; or start again without <code>cursor</code>.</td></tr>
          <tr><td>BULK_SCOPE_INVALID / TASK_IDS_REQUIRED</td><td>Bulk status needs exactly one of <code>projectId</code> or <code>teamId</code>, and an explicit list of issue ids.</td></tr>
          <tr><td>Conflicts with an existing record</td><td>A project key, team key or label name already exists.</td></tr>
          <tr><td>rate limit reached</td><td>Wait the number of seconds given, then retry. &ldquo;For this personal access token&rdquo; means the token&rsquo;s own per-minute budget, shared by every client using it; &ldquo;for this network address&rdquo; means a per-IP budget.</td></tr>
        </tbody>
      </table>

      <h2>9. Phase labels don&rsquo;t group in the dashboard</h2>
      <p>
        The dashboard groups by the exact <code>phase:N &mdash; </code> prefix (em dash U+2014, single spaces). Use{' '}
        <code>openlinear_create_phase</code> or <code>openlinear_bulk_create_plan</code>, which produce the correct
        format.
      </p>

      <Callout variant="info" title="Still stuck?">
        Error messages that came from the OpenLinear API include its request id. Share it when you report a problem.
      </Callout>

      <PageNav />
    </div>
  )
}
