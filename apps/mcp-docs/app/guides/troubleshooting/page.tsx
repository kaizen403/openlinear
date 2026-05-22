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
      <p>Expect: <code>{`{"ok":true,"ts":...}`}</code>. If this fails, the Worker is down &mdash; check <a href="https://status.cloudflare.com">Cloudflare status</a>.</p>

      <h2>2. <code>401 Unauthorized</code></h2>
      <ul>
        <li>Token doesn&rsquo;t match the format <code>ol_pat_</code> + 32 hex chars. Regenerate it.</li>
        <li>Token was revoked. Mint a new one in <strong>Settings &rarr; Personal Access Tokens</strong>.</li>
        <li>Wrong header. It must be <code>Authorization: Bearer ol_pat_xxx</code>, not <code>Token</code> or <code>X-Auth</code>.</li>
      </ul>

      <CodeBlock language="bash">{`# Quick auth check
curl -s -H "Authorization: Bearer ol_pat_xxx" \\
  https://api.openlinear.tech/api/workspaces`}</CodeBlock>

      <h2>3. Client can&rsquo;t find the server</h2>
      <ul>
        <li>Restart the client after editing the config &mdash; most clients only read MCP config at boot.</li>
        <li>Check JSON syntax. A missing comma in <code>claude_desktop_config.json</code> silently drops the entire <code>mcpServers</code> block.</li>
        <li>Ensure the client supports remote MCP over Streamable HTTP &mdash; some only support stdio.</li>
      </ul>

      <h2>4. Tool call returns a validation error</h2>
      <p>
        The most common: passing a string where a UUID is expected. Project, team, label, and task IDs
        are UUIDs; workspace IDs are strings of the form <code>workspace-&lt;hex&gt;</code>.
      </p>
      <CodeBlock language="text">{`Error: workspaceId: Invalid UUID
=> workspaceId is a string, not a UUID. Pass the workspace-<hex> value as-is.`}</CodeBlock>

      <h2>5. <code>bulk_create_plan</code> created the project but no tasks</h2>
      <p>
        Check the <code>phases[]</code> in the result. Any phase with <code>&quot;failed&quot;: true</code>
        has a per-phase error message. The most common cause is a task description over the
        10&thinsp;000-character limit.
      </p>

      <h2>6. <code>Project must have a team</code></h2>
      <p>
        If you call <code>openlinear_create_project</code> without <code>teamIds</code> and then try
        to bulk-create tasks against it, you&rsquo;ll hit this. Either:
      </p>
      <ul>
        <li>Use <code>openlinear_bulk_create_plan</code> &mdash; it auto-creates a team for you.</li>
        <li>Call <code>openlinear_create_team</code> first and pass <code>teamIds: [&lt;id&gt;]</code> when creating the project.</li>
      </ul>

      <h2>7. Phase labels don&rsquo;t group in the dashboard</h2>
      <p>
        OpenLinear&rsquo;s dashboard groups by exact <code>phase:N &mdash; </code> prefix &mdash; that&rsquo;s
        an em dash (U+2014) with single spaces. Always use the <code>openlinear_create_phase</code> or
        <code>openlinear_bulk_create_plan</code> tools, which produce the correct format.
      </p>

      <h2>8. Still stuck?</h2>
      <Callout variant="info" title="Get the request out">
        Use <code>curl</code> with the same headers and body your client would send. Compare the response
        to what the client reports &mdash; often the issue is the client logging a stale error from an
        earlier session.
      </Callout>

      <PageNav />
    </div>
  )
}
