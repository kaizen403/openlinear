import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Cursor & other clients — OpenLinear MCP' }

export default function OtherClientsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Cursor & other clients</h1>
      <p>
        Any MCP client that supports remote servers over Streamable HTTP can connect to OpenLinear.
        The endpoint and headers are the same; the config file just lives in different places.
      </p>

      <h2>Cursor</h2>
      <p>
        Open <strong>Settings &rarr; MCP &rarr; Add Server</strong>, or edit
        <code>~/.cursor/mcp.json</code> directly:
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

      <h2>Continue.dev</h2>
      <p>Add an entry to your <code>config.json</code>:</p>
      <CodeBlock language="json">{`{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "streamable-http",
          "url": "https://mcp.openlinear.tech/mcp",
          "headers": {
            "Authorization": "Bearer ol_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
          }
        }
      }
    ]
  }
}`}</CodeBlock>

      <h2>Build your own</h2>
      <p>
        The endpoint speaks the Model Context Protocol over Streamable HTTP. Use the official SDK:
      </p>
      <CodeBlock language="typescript">{`import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const transport = new StreamableHTTPClientTransport(
  new URL('https://mcp.openlinear.tech/mcp'),
  {
    requestInit: {
      headers: { Authorization: \`Bearer \${process.env.OPENLINEAR_PAT}\` },
    },
  },
)

const client = new Client({ name: 'my-agent', version: '0.1.0' })
await client.connect(transport)

const tools = await client.listTools()
console.log(tools.tools.map((t) => t.name))`}</CodeBlock>

      <Callout variant="info">
        The Worker is stateless: it ignores <code>Mcp-Session-Id</code>. Each POST creates a brand-new
        transport. Clients that demand session continuity won&rsquo;t work &mdash; but stateless clients
        like Claude Desktop, Cursor, and OpenCode do.
      </Callout>

      <PageNav />
    </div>
  )
}
