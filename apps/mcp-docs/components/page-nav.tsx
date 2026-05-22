'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { flatNav } from '@/lib/nav'

export function PageNav() {
  const pathname = usePathname()
  const idx = flatNav.findIndex((i) => i.href === pathname)
  if (idx === -1) return null
  const prev = idx > 0 ? flatNav[idx - 1] : null
  const next = idx < flatNav.length - 1 ? flatNav[idx + 1] : null
  if (!prev && !next) return null

  return (
    <div className="mt-16 flex items-center justify-between gap-3 border-t border-border/40 pt-8">
      {prev ? (
        <Link
          href={prev.href}
          className="group flex flex-1 items-center gap-3 rounded-xl border border-border/40 bg-card/30 px-4 py-3 transition-all hover:border-border hover:bg-card/60"
        >
          <ArrowLeft className="h-4 w-4 text-muted-foreground transition-transform group-hover:-translate-x-0.5" />
          <div className="text-left">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Previous</div>
            <div className="text-sm font-medium text-white">{prev.title}</div>
          </div>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
      {next ? (
        <Link
          href={next.href}
          className="group flex flex-1 items-center justify-end gap-3 rounded-xl border border-border/40 bg-card/30 px-4 py-3 transition-all hover:border-border hover:bg-card/60"
        >
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Next</div>
            <div className="text-sm font-medium text-white">{next.title}</div>
          </div>
          <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </Link>
      ) : (
        <div className="flex-1" />
      )}
    </div>
  )
}
