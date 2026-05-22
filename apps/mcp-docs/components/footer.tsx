import Link from 'next/link'

export function Footer() {
  return (
    <footer className="mt-24 border-t border-border/40 px-6 py-10">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-sm text-muted-foreground md:flex-row">
        <div className="flex items-center gap-2.5">
          <div className="flex h-5 w-5 items-center justify-center text-white/80">
            <svg viewBox="0 0 24 24" className="h-full w-full" fill="currentColor">
              <path d="M12 2L12 10L19 6L19 14L12 10L12 22L10 22L10 10L3 14L3 6L10 10L10 2Z" />
            </svg>
          </div>
          <span className="font-display text-sm text-white/80">openlinear MCP docs</span>
        </div>
        <div className="flex items-center gap-5">
          <a href="https://openlinear.tech" className="hover:text-white">openlinear.tech</a>
          <Link href="/guides/troubleshooting" className="hover:text-white">Troubleshooting</Link>
          <a href="https://mcp.openlinear.tech" className="hover:text-white">mcp.openlinear.tech</a>
        </div>
      </div>
    </footer>
  )
}
