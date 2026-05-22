import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Authentication — OpenLinear MCP' }

export default function AuthPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Authentication</h1>
      <p>
        OpenLinear MCP uses <strong>Personal Access Tokens (PATs)</strong> &mdash; long-lived,
        scoped bearer tokens you create in the OpenLinear dashboard. The MCP Worker validates the
        format and forwards each request to the OpenLinear API, which checks the token hash on every
        call.
      </p>

      <h2>Token format</h2>
      <CodeBlock language="text">{`ol_pat_<32 lowercase hex characters>`}</CodeBlock>
      <p>
        The Worker rejects anything that doesn&rsquo;t match this exact regex:
        <code>^ol_pat_[a-f0-9]{'{32}'}$</code>. Tokens are stored only as a SHA-256 hash &mdash; the
        plaintext is shown <strong>once</strong> at creation time and never again.
      </p>

      <h2>How requests are authenticated</h2>
      <p>Every MCP call must include an <code>Authorization</code> header:</p>
      <CodeBlock language="http">{`POST /mcp HTTP/1.1
Host: mcp.openlinear.tech
Authorization: Bearer ol_pat_25897b3edab3886a9601658071a9dac5
Content-Type: application/json
Accept: application/json, text/event-stream`}</CodeBlock>

      <p>The request flow:</p>
      <ol>
        <li>MCP client sends a JSON-RPC request to <code>POST /mcp</code> with the Bearer token.</li>
        <li>Worker validates the token format and creates a fresh per-request MCP transport.</li>
        <li>For each tool call, the Worker forwards an HTTPS request to the OpenLinear API with the same token.</li>
        <li>The API hashes the token, looks it up in <code>personal_access_tokens</code>, checks it isn&rsquo;t revoked or expired, and updates <code>lastUsedAt</code>.</li>
        <li>The tool result streams back to the client.</li>
      </ol>

      <h2>Creating a token</h2>
      <ol>
        <li>Sign in to <a href="https://openlinear.tech">openlinear.tech</a>.</li>
        <li>Open <strong>Settings &rarr; Personal Access Tokens</strong>.</li>
        <li>Click <strong>Generate token</strong> and give it a memorable name.</li>
        <li>Copy the token immediately and store it in a password manager.</li>
      </ol>

      <h2>Scopes</h2>
      <p>
        The current dashboard creates wildcard (<code>*</code>) tokens that grant access to every MCP tool
        you can use. The API enforces scope checks per route &mdash; for example, the bulk task endpoint
        requires the <code>tasks:write</code> scope, which the wildcard satisfies. Future versions will
        let you mint narrowly scoped tokens.
      </p>

      <h2>Revoking a token</h2>
      <p>
        In the same Settings page, click <strong>Revoke</strong> next to any token. Revocation is
        immediate &mdash; the next request using that token returns <code>401 Unauthorized</code>.
      </p>

      <Callout variant="warning" title="Treat PATs like passwords">
        A leaked PAT lets anyone act as your OpenLinear user. Never commit them, never paste them in
        screenshots, and never put them in a public MCP config. Use environment variables in your
        client&rsquo;s config when possible.
      </Callout>

      <h2>Verifying a token</h2>
      <p>You can sanity-check a token from your terminal:</p>
      <CodeBlock language="bash">{`curl -s https://api.openlinear.tech/api/workspaces \\
  -H "Authorization: Bearer ol_pat_xxxxxxxx" | jq`}</CodeBlock>
      <p>
        A <code>200</code> with your workspace list means everything is wired up. A <code>401</code>
        means the token is invalid, revoked, or expired.
      </p>

      <PageNav />
    </div>
  )
}
