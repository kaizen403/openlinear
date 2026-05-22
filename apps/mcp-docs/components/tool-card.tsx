import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'

export function ToolCard({
  name,
  href,
  description,
}: {
  name: string
  href: string
  description: string
}) {
  return (
    <Link
      href={href}
      className="group block rounded-xl border border-border/40 bg-card/30 p-4 transition-all hover:border-border hover:bg-card/60"
    >
      <div className="flex items-start justify-between gap-3">
        <code className="font-mono text-sm text-amber-200">{name}</code>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-muted-foreground transition-all group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-white" />
      </div>
      <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>
    </Link>
  )
}
