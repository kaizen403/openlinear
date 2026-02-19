"use client"

import { useState, useEffect } from "react"
import { Menu, X, Github, ChevronDown } from "lucide-react"

export function Header() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  return (
    <header className="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-full max-w-[1200px] px-4 transition-all duration-300">
      <div className="flex h-14 items-center justify-between px-6 rounded-full bg-[#0a0f1a]/80 backdrop-blur-xl border border-white/[0.08] shadow-lg shadow-black/20">
        <div className="flex items-center gap-8">
          {/* Logo */}
          <a href="/" className="flex items-center gap-2.5 group">
            <div className="h-6 w-6 text-white flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="w-full h-full" fill="currentColor">
                <path d="M12 2L12 10L19 6L19 14L12 10L12 22L10 22L10 10L3 14L3 6L10 10L10 2Z" />
              </svg>
            </div>
            <span className="font-display text-lg font-semibold tracking-tight text-white">
              openlinear<span className="text-[10px] align-top relative top-1 ml-0.5 text-white/50">™</span>
            </span>
          </a>

          {/* Desktop Nav */}
          <nav className="hidden lg:flex items-center gap-1.5 ml-4">
            <NavLink href="/product">Research</NavLink>
            <button className="flex items-center gap-1 px-3 py-2 text-sm text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/[0.04]">
              Use cases <ChevronDown className="h-3.5 w-3.5 opacity-70" />
            </button>
            <NavLink href="/pricing">Pricing</NavLink>
            <NavLink href="/docs">Docs</NavLink>
            <NavLink href="/blog">Blog</NavLink>
            <NavLink href="/about">About</NavLink>
            <NavLink href="/consumer">Consumer</NavLink>
          </nav>
        </div>

        {/* Right side actions */}
        <div className="hidden md:flex items-center gap-4">
          <a 
            href="https://github.com/kaizen403/openlinear" 
            className="flex items-center gap-2 text-sm text-white/60 hover:text-white transition-colors pr-2"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="font-medium text-white/80">X</span>
            <span className="font-medium">1.2k</span>
          </a>

          <a
            href="https://dashboard.rixie.in"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-white/[0.04] border border-white/[0.1] text-sm font-medium text-white/90 hover:text-white hover:bg-white/[0.08] transition-all"
          >
            Try for Free <ArrowRight className="h-3.5 w-3.5 ml-0.5 opacity-70" />
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          type="button"
          className="lg:hidden text-white/60 hover:text-white transition-colors"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
        >
          {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile Menu */}
      {mobileMenuOpen && (
        <div className="lg:hidden absolute top-16 left-4 right-4 bg-[#0a0f1a]/95 backdrop-blur-xl border border-white/[0.08] rounded-2xl p-4 shadow-2xl mt-2">
          <div className="flex flex-col gap-1">
            <MobileNavLink href="/product">Research</MobileNavLink>
            <MobileNavLink href="/enterprise">Use cases</MobileNavLink>
            <MobileNavLink href="/pricing">Pricing</MobileNavLink>
            <MobileNavLink href="/docs">Docs</MobileNavLink>
            <MobileNavLink href="/blog">Blog</MobileNavLink>
            <MobileNavLink href="/about">About</MobileNavLink>
            
            <hr className="border-white/[0.06] my-4" />
            
            <a
              href="https://dashboard.rixie.in"
              className="flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-white/[0.06] border border-white/[0.12] text-sm font-medium text-white hover:bg-white/[0.1] transition-all"
            >
              Try for Free <ArrowRight className="h-4 w-4" />
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
      className="px-3 py-2 text-sm text-white/70 hover:text-white transition-colors rounded-lg hover:bg-white/[0.04]"
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

function ArrowRight({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3.33331 8H12.6666" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M8 3.33337L12.6667 8.00004L8 12.6667" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}
