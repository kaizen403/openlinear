import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Team tools — OpenLinear MCP' }

export default function TeamsPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Team tools</h1>
      <p>
        Teams are the issue-numbering boundary: every issue is identified as <code>&lt;TEAM_KEY&gt;-&lt;N&gt;</code>{' '}
        (e.g. <code>MAL-42</code>). Each team belongs to exactly one project, and every new project gets a default
        team. Team members are the users an issue can be assigned to.
      </p>

      <ToolReference name="openlinear_list_teams">
        <h3>Returns</h3>
        <CodeBlock language="json">{`{
  "teams": [
    {
      "id": "…",
      "key": "MAL",
      "name": "Mobile App Team",
      "projectId": "…",
      "projectName": "Mobile App Launch",
      "private": false,
      "memberCount": 2,
      "issueCount": 14,
      "members": [
        { "userId": "…", "username": "alice", "role": "owner" },
        { "userId": "…", "username": "bob", "role": "member" }
      ]
    }
  ]
}`}</CodeBlock>
      </ToolReference>

      <ToolReference name="openlinear_create_team">
        <CodeBlock language="json">{`{
  "tool": "openlinear_create_team",
  "input": { "projectId": "…", "name": "Platform", "key": "PLT", "color": "#10B981" }
}`}</CodeBlock>
      </ToolReference>

      <PageNav />
    </div>
  )
}
