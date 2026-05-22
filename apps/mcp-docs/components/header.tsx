'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Github, Menu, X } from 'lucide-react'

export function Header() {
  const [open, setOpen] = useState(false)
  return (
    <header className="fixed top-4 left-1/2 z-50 w-full max-w-[1200px] -translate-x-1/2 px-4 transition-all duration-300">
      <div className="flex h-14 items-center justify-between rounded-full border border-white/[0.08] bg-[#0a0f1a]/80 px-5 shadow-lg shadow-black/20 backdrop-blur-xl">
        <div className="flex items-center gap-6">
          <Link href="/" className="group flex items-center gap-2.5">
            <img src="/brand/logomark-dark.svg" alt="OpenLinear" className="h-6 w-6" />
            <span className="font-display text-base font-semibold tracking-tight text-white">
              OpenLinear
              <span className="ml-2 rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[10px] font-medium tracking-wider text-white/70">
                MCP
              </span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            <NavLink href="/quickstart">Quickstart</NavLink>
            <NavLink href="/tools">Tools</NavLink>
            <NavLink href="/guides/plan-from-prompt">Guides</NavLink>
          </nav>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <a
            href="https://github.com/openlinear/openlinear"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 pr-1 text-sm text-white/60 transition-colors hover:text-white"
            aria-label="GitHub"
          >
            <Github className="h-4 w-4" />
          </a>
        </div>

        <button
          type="button"
          className="text-white/60 transition-colors hover:text-white md:hidden"
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {open && (
        <div className="absolute left-4 right-4 top-16 mt-2 rounded-2xl border border-white/[0.08] bg-[#0a0f1a]/95 p-4 shadow-2xl backdrop-blur-xl md:hidden">
          <div className="flex flex-col gap-1">
            <MobileLink href="/quickstart">Quickstart</MobileLink>
            <MobileLink href="/tools">Tools</MobileLink>
            <MobileLink href="/guides/plan-from-prompt">Guides</MobileLink>
          </div>
        </div>
      )}
    </header>
  )
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-lg px-3 py-2 text-sm text-white/70 transition-colors hover:bg-white/[0.04] hover:text-white"
    >
      {children}
    </Link>
  )
}

function MobileLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-lg px-3 py-3 text-base text-white/80 transition-colors hover:bg-white/[0.04] hover:text-white"
    >
      {children}
    </Link>
  )
}
