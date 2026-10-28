import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Authentication — OpenLinear MCP' }

export default function AuthPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Authentication</h1>
      <p>
        OpenLinear MCP uses <strong>Personal Access Tokens (PATs)</strong>: long-lived, scoped bearer tokens you create
        in the OpenLinear dashboard. Every request to the MCP endpoint must carry one.
      </p>

      <h2>Token format</h2>
      <CodeBlock language="text">{`ol_pat_<32 lowercase hex characters>`}</CodeBlock>
      <p>
        Tokens are stored only as a SHA-256 hash; the plaintext is shown <strong>once</strong> at creation time.
      </p>

      <h2>How requests are authenticated</h2>
      <CodeBlock language="http">{`POST /mcp HTTP/1.1
Host: mcp.openlinear.tech
Authorization: Bearer ol_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
Accept: application/json, text/event-stream`}</CodeBlock>
      <ol>
        <li>The server checks the token format, then verifies the token with the OpenLinear API. A verified token is remembered for up to a minute.</li>
        <li>Every MCP request needs a valid token, including <code>initialize</code> and <code>tools/list</code>.</li>
        <li>Each tool call forwards your token to the OpenLinear API, which applies your scopes, role, project access and workspace binding.</li>
        <li>If the API stops accepting the token (for example after you revoke it), that tool call fails and the next request gets <code>401</code>.</li>
      </ol>

      <h2>Failure responses</h2>
      <table>
        <thead><tr><th>Status</th><th>When</th></tr></thead>
        <tbody>
          <tr><td><code>401</code></td><td>Missing, malformed, unknown, expired or revoked token. The <code>WWW-Authenticate: Bearer</code> header carries <code>error=&quot;invalid_token&quot;</code> (omitted when no token was sent) and <code>resource_metadata</code>.</td></tr>
          <tr><td><code>403</code></td><td>The API refuses the token for a reason other than its scopes (<code>error=&quot;insufficient_scope&quot;</code>), or a browser request comes from an Origin that is not allowed. Tokens with only narrow scopes are accepted; each tool call is scope-checked by the API.</td></tr>
          <tr><td><code>503</code></td><td>The OpenLinear API could not be reached to verify the token. Retry after the <code>Retry-After</code> seconds.</td></tr>
        </tbody>
      </table>
      <p>
        The server publishes OAuth protected-resource metadata (RFC 9728) at{' '}
        <code>https://mcp.openlinear.tech/.well-known/oauth-protected-resource/mcp</code>. It lists no authorization
        server yet: OpenLinear does not offer OAuth sign-in for MCP clients today, so configure a PAT header.
      </p>

      <h2>Scopes</h2>
      <p>
        Choose the scopes when you create the token. The generic scopes are the simple choice; narrow scopes cover one
        family of tools each (a <code>:write</code> scope includes the matching <code>:read</code>):
      </p>
      <table>
        <thead><tr><th>Scope</th><th>Allows</th></tr></thead>
        <tbody>
          <tr><td><code>read</code></td><td>Every read-only tool (list, get, search).</td></tr>
          <tr><td><code>write</code></td><td>Every tool.</td></tr>
          <tr><td><code>tasks:read</code> / <code>tasks:write</code></td><td>Issue tools: list, get, create, update, assign, label, bulk status, comment.</td></tr>
          <tr><td><code>projects:read</code> / <code>projects:write</code></td><td>Projects and teams (list, get, create) and reading labels.</td></tr>
          <tr><td><code>labels:write</code></td><td>Creating labels and phases (with <code>projects:read</code> to reuse existing ones).</td></tr>
          <tr><td><code>workspaces:read</code></td><td><code>openlinear_list_workspaces</code>.</td></tr>
        </tbody>
      </table>
      <p>
        Each tool&rsquo;s reference lists the scopes it needs, e.g. <code>openlinear_search</code> needs{' '}
        <code>read</code> or <code>tasks:read + projects:read</code>, and <code>openlinear_bulk_create_plan</code>{' '}
        needs <code>write</code> or <code>projects:write + labels:write + tasks:write</code>. A tool the token cannot
        use answers with a scope error that names those scopes.
      </p>
      <p>
        With only narrow scopes the server cannot look up the token&rsquo;s owner, so tools that write{' '}
        <code>&quot;me&quot;</code> as a user (<code>openlinear_assign_issue</code>, <code>assigneeIds</code> of{' '}
        <code>openlinear_create_issue</code>) ask for your user id instead. Filters such as{' '}
        <code>assignee: &quot;me&quot;</code> keep working.
      </p>

      <h2>Workspace-bound tokens</h2>
      <p>
        A token bound to one workspace (created with the <code>workspaceId</code> option of{' '}
        <code>POST /api/pats</code>; the dashboard does not offer it yet) only sees that workspace:{' '}
        <code>openlinear_list_workspaces</code> returns it alone, new projects land in it, and ids from other
        workspaces are refused (<code>Access denied …</code> or <code>PAT_WORKSPACE_RESTRICTED</code>).
      </p>

      <h2>Creating and revoking tokens</h2>
      <ol>
        <li>Sign in to <a href="https://openlinear.tech">openlinear.tech</a>.</li>
        <li>Open <strong>Settings &rarr; Personal Access Tokens</strong>.</li>
        <li>Click <strong>Generate token</strong>, pick the scopes, and copy the token.</li>
        <li>Revoke a token from the same page; the MCP server refuses it within a minute (immediately once a tool call is refused).</li>
      </ol>

      <Callout variant="warning" title="Treat PATs like passwords">
        A leaked PAT lets anyone act as you within its scopes. Never commit tokens or paste them into screenshots;
        reference an environment variable from your client configuration where the client supports it.
      </Callout>

      <PageNav />
    </div>
  )
}
