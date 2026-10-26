"use client"

import { useState } from "react"
import { Menu, X } from "lucide-react"

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <header className="sticky top-0 z-50 flex h-[80px] items-center justify-between bg-background px-6 md:px-20 border-b border-foreground/10">
      <div>
        <a href="/" className="flex items-center gap-3">
          <img src="/logo.png" alt="OpenLinear" className="h-[40px]" loading="lazy" />
          <span className="text-[20px] font-semibold tracking-tight text-foreground">OpenLinear</span>
        </a>
      </div>

      <nav className="hidden md:block">
        <ul className="flex items-center gap-8">
          <li>
            <a href="https://openlinear.mintlify.app" className="text-[16px] text-foreground hover:text-foreground/60 transition-colors">
              Docs
            </a>
          </li>
          <li>
            <a href="https://github.com/kaizen403/openlinear" className="text-[16px] text-foreground hover:text-foreground/60 transition-colors">
              GitHub
            </a>
          </li>
          <li>
            <a
              href="https://github.com/kaizen403/openlinear/releases"
              className="inline-flex items-center gap-2 rounded bg-foreground pl-2.5 pr-4 py-2 text-[16px] font-medium text-background hover:bg-foreground/90 active:scale-[0.98] transition-all"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                <path d="M12.1875 9.75L9.00001 12.9375L5.8125 9.75M9.00001 2.0625L9 12.375M14.4375 15.9375H3.5625" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/>
              </svg>
              Free
            </a>
          </li>
        </ul>
      </nav>

      <button
        type="button"
        className="md:hidden text-foreground p-2 -mr-2 min-w-[44px] min-h-[44px] flex items-center justify-center"
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
      >
        {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {mobileMenuOpen && (
        <div className="absolute top-[80px] left-0 right-0 md:hidden border-b border-foreground/10 bg-background px-6 py-6">
          <ul className="flex flex-col gap-1">
            <li><a href="https://openlinear.mintlify.app" className="block text-[16px] text-foreground py-3">Docs</a></li>
            <li><a href="https://github.com/kaizen403/openlinear" className="block text-[16px] text-foreground py-3">GitHub</a></li>
            <li>
              <a
                href="https://github.com/kaizen403/openlinear/releases"
                className="mt-2 flex items-center justify-center gap-2 rounded bg-foreground px-4 py-2.5 text-[16px] font-medium text-background"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg" className="shrink-0">
                  <path d="M12.1875 9.75L9.00001 12.9375L5.8125 9.75M9.00001 2.0625L9 12.375M14.4375 15.9375H3.5625" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square"/>
                </svg>
                Free
              </a>
            </li>
          </ul>
        </div>
      )}
    </header>
  )
}
