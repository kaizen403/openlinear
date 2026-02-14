"use client"

import { useState, useEffect } from "react"
import { Menu, X } from "lucide-react"

export function Header() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-[350ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)] ${scrolled
        ? "bg-background/80 backdrop-blur-2xl border-b border-border/20 shadow-[0_1px_3px_rgba(0,0,0,0.02)]"
        : "bg-transparent"
        }`}
    >
      <div className="mx-auto max-w-none px-[100px]">
        <div className="flex h-16 items-center justify-between">
          {/* Logo */}
          <a href="/" onClick={() => window.location.href = '/'} className="flex items-center">
            <span className="font-display text-[0.875rem] font-semibold tracking-[0.1em] text-foreground uppercase">
              OpenLinear
            </span>
          </a>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-9">
            <a href="/product" className="text-sm text-muted-foreground/60 transition-colors duration-250 hover:text-foreground/80">
              Product
            </a>
            <a href="/enterprise" className="text-sm text-muted-foreground/60 transition-colors duration-250 hover:text-foreground/80">
              Enterprise
            </a>
            <a href="/pricing" className="text-sm text-muted-foreground/60 transition-colors duration-250 hover:text-foreground/80">
              Pricing
            </a>
            <a href="/docs" className="text-sm text-muted-foreground/60 transition-colors duration-250 hover:text-foreground/80">
              Docs
            </a>
            <a href="/contact" className="text-sm text-muted-foreground/60 transition-colors duration-250 hover:text-foreground/80">
              Contact us
            </a>
          </nav>

          {/* Actions */}
          <div className="hidden md:flex items-center gap-4">
            <a href="#" className="text-sm text-muted-foreground/60 transition-colors duration-250 hover:text-foreground/80">
              Log in
            </a>
            <a
              href="#"
              className="btn-primary inline-flex items-center justify-center rounded-full bg-primary px-5 py-[7px] text-[0.8125rem] font-medium text-primary-foreground"
            >
              Download
            </a>
          </div>

          {/* Mobile toggle */}
          <button
            className="md:hidden text-foreground/50"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden bg-background/95 backdrop-blur-2xl border-t border-border/15">
          <div className="px-6 py-5 flex flex-col gap-0.5">
            <a href="/product" className="text-sm text-foreground/80 py-2.5 transition-colors duration-200 hover:text-primary">Product</a>
            <a href="/enterprise" className="text-sm text-foreground/80 py-2.5 transition-colors duration-200 hover:text-primary">Enterprise</a>
            <a href="/pricing" className="text-sm text-foreground/80 py-2.5 transition-colors duration-200 hover:text-primary">Pricing</a>
            <a href="/docs" className="text-sm text-foreground/80 py-2.5 transition-colors duration-200 hover:text-primary">Docs</a>
            <a href="/contact" className="text-sm text-foreground/80 py-2.5 transition-colors duration-200 hover:text-primary">Contact us</a>
            <hr className="border-border/15 my-3" />
            <div className="py-2.5">
              <a href="#" className="text-sm text-foreground/80">Log in</a>
            </div>
            <a
              href="#"
              className="btn-primary inline-flex items-center justify-center rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground mt-2"
            >
              Download
            </a>
          </div>
        </div>
      )}
    </header>
  )
}
