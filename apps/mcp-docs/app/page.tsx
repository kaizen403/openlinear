import Link from 'next/link'
import { ArrowRight, Zap, Layers, ShieldCheck, Bot } from 'lucide-react'
import { CodeBlock } from '@/components/code-block'
import { PageNav } from '@/components/page-nav'

export default function HomePage() {
  return (
    <div className="docs-prose max-w-3xl">
      <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.04] px-3 py-1 text-xs text-white/70 hero-reveal-1">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]" />
        mcp.openlinear.tech is live
      </div>

      <h1 className="hero-reveal-2">
        Think it. <span className="text-white/60">Plan it. Ship it.</span>
      </h1>

      <p className="hero-reveal-3 text-lg text-foreground/80">
        OpenLinear MCP is a Model Context Protocol server that lets any compatible AI client &mdash;
        Claude, Cursor, OpenCode &mdash; turn a multi-phase plan into a fully populated dashboard with a
        single tool call. Real projects, real teams, real issues. Then execute them with one click.
      </p>

      <div className="mt-7 flex flex-wrap items-center gap-3 hero-reveal-3">
        <Link
          href="/quickstart"
          className="btn-primary inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-all"
        >
          Quickstart <ArrowRight className="h-4 w-4" />
        </Link>
        <Link
          href="/tools"
          className="btn-secondary inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.03] px-5 py-2.5 text-sm font-medium text-white/90 transition-all hover:text-white"
        >
          Browse tools
        </Link>
      </div>

      <div className="my-10 grid gap-3 sm:grid-cols-2 not-prose">
        {features.map((f) => (
          <div key={f.title} className="glass-card rounded-xl p-4">
            <div className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <f.icon className="h-4 w-4" />
            </div>
            <div className="font-display text-sm font-semibold text-white">{f.title}</div>
            <div className="mt-1 text-sm text-muted-foreground">{f.desc}</div>
          </div>
        ))}
      </div>

      <h2>What it does</h2>
      <p>
        OpenLinear MCP exposes <strong>12 tools</strong> covering the full lifecycle of planning work in
        OpenLinear &mdash; reading workspaces, creating projects and teams, defining phases as labels, and
        creating individual issues or bulk plans. The headline tool, <code>openlinear_bulk_create_plan</code>,
        turns an entire AI-generated plan (project &rarr; phases &rarr; tasks) into a fully wired dashboard
        in one round trip.
      </p>

      <h2>One call, one populated dashboard</h2>
      <CodeBlock language="json">{`{
  "tool": "openlinear_bulk_create_plan",
  "input": {
    "project": { "name": "Mobile App Launch", "key": "MAL" },
    "phases": [
      {
        "name": "Foundation",
        "tasks": [
          { "title": "Set up monorepo" },
          { "title": "CI/CD pipeline" }
        ]
      },
      {
        "name": "Onboarding",
        "tasks": [
          { "title": "Sign in screen" },
          { "title": "Email verification" }
        ]
      }
    ]
  }
}`}</CodeBlock>

      <p>
        OpenLinear MCP creates the project, auto-creates a team if you didn&rsquo;t pass one, builds a
        <code>phase:N &mdash; Name</code> label per phase, and bulk-inserts all tasks against the right
        labels. You walk away with a project URL and the IDs of every task it created.
      </p>

      <h2>Architecture</h2>
      <p>
        The server is a <strong>stateless Cloudflare Worker</strong> using the official MCP TypeScript SDK
        over Streamable HTTP. Each request creates a fresh transport, validates your Personal Access Token,
        and forwards calls to the OpenLinear REST API on your behalf. No queues, no databases, no state.
      </p>

      <p>
        Production endpoint: <code>https://mcp.openlinear.tech/mcp</code>
      </p>

      <h2>Get started</h2>
      <p>
        Three steps and you&rsquo;re live: create a Personal Access Token in OpenLinear settings, paste a
        config block into your AI client, then ask the model to plan something.
      </p>

      <div className="not-prose mt-4 grid gap-3 sm:grid-cols-3">
        <StepCard num="1" title="Get a PAT" href="/authentication" />
        <StepCard num="2" title="Configure client" href="/clients/claude-desktop" />
        <StepCard num="3" title="Prompt the model" href="/guides/plan-from-prompt" />
      </div>

      <PageNav />
    </div>
  )
}

const features = [
  { icon: Zap, title: 'Stateless & fast', desc: 'Cloudflare Worker. No cold starts, no sessions.' },
  { icon: Layers, title: '12 typed tools', desc: 'Full CRUD over workspaces, projects, teams, labels, issues.' },
  { icon: ShieldCheck, title: 'PAT-based auth', desc: 'Scoped Personal Access Tokens. Revoke any time.' },
  { icon: Bot, title: 'Built for agents', desc: 'Designed around plan &rarr; execute workflows.' },
]

function StepCard({ num, title, href }: { num: string; title: string; href: string }) {
  return (
    <Link
      href={href}
      className="group glass-card flex items-center gap-3 rounded-xl p-4 transition-all"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-sm text-primary">
        {num}
      </span>
      <span className="text-sm font-medium text-white">{title}</span>
      <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}
