"use client"

import { useState, useEffect } from "react"
import { Menu, X, Github } from "lucide-react"

export function Header() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 20)
    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? "bg-[#0a0f1a]/80 backdrop-blur-xl border-b border-white/[0.06]"
          : "bg-transparent"
      }`}
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-8">
            <a href="/" className="flex items-center gap-2.5 group">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center">
                <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M12 4v16M4 12l8-8 8 8" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <span className="font-display text-[0.9375rem] font-semibold tracking-tight text-white">
                OpenLinear
              </span>
            </a>

            <nav className="hidden lg:flex items-center gap-1">
              <NavLink href="/product">Product</NavLink>
              <NavLink href="/enterprise">Use cases</NavLink>
              <NavLink href="/pricing">Pricing</NavLink>
              <NavLink href="/docs">Docs</NavLink>
              <NavLink href="/contact">Contact</NavLink>
            </nav>
          </div>

          <div className="hidden md:flex items-center gap-4">
            <a 
              href="https://github.com/kaizen403/openlinear" 
              className="flex items-center gap-2 text-sm text-white/50 hover:text-white/80 transition-colors"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Github className="h-4 w-4" />
              <span className="font-medium">1.2k</span>
            </a>

            <a
              href="https://dashboard.rixie.in"
              className="inline-flex items-center gap-1.5 px-5 py-2 rounded-full bg-white/[0.06] border border-white/[0.12] text-sm font-medium text-white hover:bg-white/[0.1] hover:border-white/[0.2] transition-all"
            >
              Try for Free
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
                <path d="M3 8h10M10 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
          </div>

          <button
            type="button"
            className="md:hidden text-white/60 hover:text-white transition-colors"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden bg-[#0a0f1a]/95 backdrop-blur-xl border-t border-white/[0.06]">
          <div className="px-4 py-6 flex flex-col gap-1">
            <MobileNavLink href="/product">Product</MobileNavLink>
            <MobileNavLink href="/enterprise">Use cases</MobileNavLink>
            <MobileNavLink href="/pricing">Pricing</MobileNavLink>
            <MobileNavLink href="/docs">Docs</MobileNavLink>
            <MobileNavLink href="/contact">Contact</MobileNavLink>
            
            <hr className="border-white/[0.06] my-4" />
            
            <a
              href="https://dashboard.rixie.in"
              className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white/[0.06] border border-white/[0.12] text-sm font-medium text-white hover:bg-white/[0.1] transition-all"
            >
              Try for Free
              <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none">
                <path d="M3 8h10M10 5l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </a>
          </div>
        </div>
      )}
    </header>
  )
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="px-3 py-2 text-sm text-white/60 hover:text-white transition-colors rounded-lg hover:bg-white/[0.04]"
    >
      {children}
    </a>
  )
}

function MobileNavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className="px-3 py-3 text-base text-white/80 hover:text-white hover:bg-white/[0.04] rounded-lg transition-colors"
    >
      {children}
    </a>
  )
}
