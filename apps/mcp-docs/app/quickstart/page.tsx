import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export const metadata = { title: 'Quickstart — OpenLinear MCP' }

export default function QuickstartPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Quickstart</h1>
      <p>
        Connect any MCP-compatible client to OpenLinear in under three minutes. You&rsquo;ll create a token,
        configure your client, and run your first tool call.
      </p>

      <h2>1. Create a Personal Access Token</h2>
      <ol>
        <li>
          Open <a href="https://openlinear.tech">openlinear.tech</a> and sign in.
        </li>
        <li>
          Go to <strong>Settings &rarr; Personal Access Tokens</strong>.
        </li>
        <li>
          Click <strong>Generate token</strong>, name it (e.g. <em>Claude desktop</em>), and copy the value.
        </li>
      </ol>

      <Callout variant="warning" title="Tokens are shown once.">
        Only a SHA-256 hash is stored. Save the token in a password manager. If you lose it,
        revoke and create a new one.
      </Callout>

      <p>
        Tokens look like this:
      </p>
      <CodeBlock language="text">{`ol_pat_25897b3edab3886a9601658071a9dac5`}</CodeBlock>

      <h2>2. Add OpenLinear to your MCP client</h2>
      <p>
        Most clients accept a JSON config block. Use this for Claude Desktop, Cursor, or any other client
        that supports remote MCP servers via HTTP:
      </p>
      <CodeBlock language="json" filename="mcp config">{`{
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
        See client-specific instructions in <a href="/clients/claude-desktop">Clients</a>.
      </p>

      <h2>3. Verify the connection</h2>
      <p>
        Restart your client, open a chat, and ask:
      </p>
      <blockquote>
        &ldquo;List my OpenLinear workspaces.&rdquo;
      </blockquote>
      <p>
        The model should call <code>openlinear_list_workspaces</code> and return your workspaces with member
        and project counts. If it doesn&rsquo;t, see <a href="/guides/troubleshooting">Troubleshooting</a>.
      </p>

      <h2>4. Create your first plan</h2>
      <p>
        Try the headline tool:
      </p>
      <blockquote>
        &ldquo;Use OpenLinear to plan a 3-phase migration project called &lsquo;Postgres Upgrade&rsquo;:
        Phase 1 prep work, Phase 2 dual-write, Phase 3 cutover.&rdquo;
      </blockquote>
      <p>
        The model will call <code>openlinear_bulk_create_plan</code>, create a project, three phase labels,
        and one task per item it generates. Check your OpenLinear dashboard &mdash; the project is there,
        tasks bucketed by phase, ready to execute.
      </p>

      <Callout variant="tip" title="Next">
        Browse the <a href="/tools">tools reference</a> to learn what every tool accepts and returns, or
        skip to <a href="/guides/plan-from-prompt">Plan from a prompt</a> for end-to-end examples.
      </Callout>

      <PageNav />
    </div>
  )
}
