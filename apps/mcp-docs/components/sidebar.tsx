'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { navigation } from '@/lib/nav'
import { cn } from '@/lib/cn'

export function Sidebar() {
  const pathname = usePathname()
  return (
    <aside className="sticky top-24 hidden h-[calc(100vh-7rem)] w-60 shrink-0 overflow-y-auto pr-4 lg:block">
      <nav className="space-y-7 pb-12 pt-2">
        {navigation.map((section) => (
          <div key={section.title}>
            <h4 className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              {section.title}
            </h4>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = pathname === item.href
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        'block rounded-md px-3 py-1.5 text-sm transition-colors',
                        active
                          ? 'bg-white/[0.05] text-white'
                          : 'text-foreground/70 hover:bg-white/[0.03] hover:text-white'
                      )}
                    >
                      {item.title}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  )
}
