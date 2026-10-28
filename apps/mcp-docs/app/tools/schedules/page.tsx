import { Callout } from '@/components/callout'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'
import { ToolReference } from '@/components/tool-reference'

export const metadata = { title: 'Recurring issues — OpenLinear MCP' }

export default function SchedulesPage() {
  return (
    <div className="docs-prose max-w-3xl">
      <h1>Recurring issues</h1>
      <p className="text-lg text-foreground/85">
        Create the same issue on a schedule — every day, every weekday, every week or every month — at a local time
        in the time zone you choose. Each run creates one issue from the template; nothing runs it.
      </p>

      <Callout variant="tip" title="Check first">
        Call <code>openlinear_list_schedules</code> before creating one: a project may already have a schedule for the
        same chore, and a project has at most 25 active schedules.
      </Callout>

      <h2>How a schedule works</h2>
      <ul>
        <li>
          <code>cadence</code> is <code>daily</code>, <code>weekdays</code> (Monday to Friday), <code>weekly</code>{' '}
          (with <code>weekday</code>, 0 = Sunday) or <code>monthly</code> (with <code>dayOfMonth</code>, 1-28).
        </li>
        <li>
          <code>time</code> is a local <code>HH:MM</code> in <code>timezone</code> (an IANA name such as{' '}
          <code>Europe/Berlin</code>). Daylight saving is handled: a time skipped by the change runs right after it, a
          repeated time runs once.
        </li>
        <li>
          <code>{'{date}'}</code> in the title becomes each issue&apos;s date. After downtime only the most recent
          missed run creates an issue.
        </li>
        <li>People pause, resume, edit, delete and &ldquo;run now&rdquo; schedules in the OpenLinear app.</li>
      </ul>

      <ToolReference name="openlinear_list_schedules" />
      <ToolReference name="openlinear_create_schedule">
        <CodeBlock language="json">{`{
  "projectId": "…",
  "title": "Dependency updates {date}",
  "cadence": "weekly",
  "weekday": 1,
  "time": "09:00",
  "timezone": "Europe/Berlin",
  "priority": "low"
}`}</CodeBlock>
      </ToolReference>

      <PageNav />
    </div>
  )
}
