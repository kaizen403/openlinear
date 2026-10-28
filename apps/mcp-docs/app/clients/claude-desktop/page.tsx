import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Claude Desktop — OpenLinear MCP' }

export default function ClaudeDesktopPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Claude Desktop</h1>
      <p>
        Claude Desktop&rsquo;s <code>claude_desktop_config.json</code> starts local (stdio) servers. To reach the remote
        OpenLinear server with a personal access token, run the <code>mcp-remote</code> bridge from that file.
      </p>

      <h2>Config file location</h2>
      <ul>
        <li><strong>macOS</strong>: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></li>
        <li><strong>Windows</strong>: <code>%APPDATA%\Claude\claude_desktop_config.json</code></li>
        <li><strong>Linux</strong>: <code>~/.config/Claude/claude_desktop_config.json</code></li>
      </ul>

      <h2>Configuration</h2>
      <CodeBlock language="json" filename="claude_desktop_config.json">{`{
  "mcpServers": {
    "openlinear": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://mcp.openlinear.tech/mcp",
        "--header",
        "Authorization:\${OPENLINEAR_AUTH}"
      ],
      "env": {
        "OPENLINEAR_AUTH": "Bearer ol_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}`}</CodeBlock>

      <p>
        Replace the token with your own from <a href="/authentication">Settings &rarr; Personal Access Tokens</a>. The
        header value lives in <code>env</code> so the space after <code>Bearer</code> survives argument splitting on
        every platform. Save the file and fully quit Claude Desktop (<kbd>Cmd+Q</kbd> on macOS) before reopening it.
        The bridge needs Node.js.
      </p>

      <h2>Verify</h2>
      <p>Open a new conversation and ask:</p>
      <blockquote>&ldquo;List my OpenLinear workspaces.&rdquo;</blockquote>
      <p>Claude should call <code>openlinear_list_workspaces</code> and show your workspaces.</p>

      <Callout variant="tip" title="Combine with other MCP servers">
        Pair OpenLinear with a filesystem server and you can ask Claude to read your spec doc, then create the
        matching plan.
      </Callout>

      <PageNav />
    </div>
  )
}
