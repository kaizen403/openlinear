import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Claude Code, Codex, Cursor & others — OpenLinear MCP' }

export default function OtherClientsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Claude Code, Codex, Cursor & others</h1>
      <p>
        Any MCP client that supports remote servers over Streamable HTTP with a custom header can connect. The
        endpoint is always <code>https://mcp.openlinear.tech/mcp</code> with{' '}
        <code>Authorization: Bearer ol_pat_…</code>.
      </p>

      <h2>Claude Code</h2>
      <CodeBlock language="bash">{`claude mcp add --transport http openlinear https://mcp.openlinear.tech/mcp \\
  --header "Authorization: Bearer ol_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"`}</CodeBlock>
      <p>Or in a project&rsquo;s <code>.mcp.json</code>, reading the token from an environment variable:</p>
      <CodeBlock language="json" filename=".mcp.json">{`{
  "mcpServers": {
    "openlinear": {
      "type": "http",
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": { "Authorization": "Bearer \${OPENLINEAR_PAT}" }
    }
  }
}`}</CodeBlock>

      <h2>Codex</h2>
      <CodeBlock language="toml" filename="~/.codex/config.toml">{`[mcp_servers.openlinear]
url = "https://mcp.openlinear.tech/mcp"
bearer_token_env_var = "OPENLINEAR_PAT"`}</CodeBlock>

      <h2>Cursor</h2>
      <p>
        Open <strong>Settings &rarr; MCP &rarr; Add Server</strong>, or edit <code>~/.cursor/mcp.json</code>:
      </p>
      <CodeBlock language="json" filename="~/.cursor/mcp.json">{`{
  "mcpServers": {
    "openlinear": {
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": {
        "Authorization": "Bearer ol_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}`}</CodeBlock>

      <h2>Build your own</h2>
      <p>Use the official TypeScript SDK client:</p>
      <CodeBlock language="typescript">{`import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const transport = new StreamableHTTPClientTransport(new URL('https://mcp.openlinear.tech/mcp'), {
  requestInit: { headers: { Authorization: \`Bearer \${process.env.OPENLINEAR_PAT}\` } },
})

const client = new Client({ name: 'my-agent', version: '0.1.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log(tools.map((tool) => tool.name))`}</CodeBlock>

      <Callout variant="info" title="Stateless server">
        The server keeps no sessions: it never issues an <code>Mcp-Session-Id</code>, and <code>GET</code>/
        <code>DELETE</code> on <code>/mcp</code> answer <code>405</code>. Clients on the 2025 protocol revisions
        (initialize handshake) and on the stateless 2026-07-28 revision both work.
      </Callout>

      <PageNav />
    </div>
  )
}
