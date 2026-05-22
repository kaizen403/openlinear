import { CodeBlock } from '@/components/code-block'
import { Callout } from '@/components/callout'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Claude Desktop — OpenLinear MCP' }

export default function ClaudeDesktopPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Claude Desktop</h1>
      <p>
        Add OpenLinear to Claude Desktop in under a minute. Claude reads its MCP configuration from
        a single JSON file.
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
      "url": "https://mcp.openlinear.tech/mcp",
      "headers": {
        "Authorization": "Bearer ol_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}`}</CodeBlock>

      <p>
        Replace the token with your own from <a href="/authentication">Settings &rarr; Personal Access Tokens</a>.
        Save the file and fully quit Claude Desktop (<kbd>Cmd+Q</kbd> on macOS) before reopening it.
      </p>

      <h2>Verify</h2>
      <p>
        Open a new conversation. Claude shows installed MCP servers in the prompt input area &mdash; you
        should see <code>openlinear</code> with a green dot. Ask:
      </p>
      <blockquote>
        &ldquo;List my OpenLinear workspaces.&rdquo;
      </blockquote>
      <p>
        Claude should call <code>openlinear_list_workspaces</code> and show your workspaces in the result.
      </p>

      <Callout variant="tip" title="Combine with other MCP servers">
        Claude Desktop supports multiple MCP servers at once. Pair OpenLinear with a filesystem server
        and you can ask Claude to read your spec doc, then auto-create the matching plan.
      </Callout>

      <PageNav />
    </div>
  )
}
