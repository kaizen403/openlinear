import { Github } from 'lucide-react'

const footerLinks = [
  { label: 'GitHub', href: 'https://github.com/kaizen403/openlinear' },
  { label: 'Docs', href: 'https://github.com/kaizen403/openlinear#readme' },
  { label: 'Changelog', href: 'https://github.com/kaizen403/openlinear/releases' },
  { label: 'Discord', href: '#' },
  { label: 'X', href: '#' },
]

const legalLinks = [
  { label: 'Privacy', href: '#' },
  { label: 'Terms', href: '#' },
]

export default function Footer() {
  return (
    <footer className="py-8 border-t border-border">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            {footerLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.href.startsWith('http') ? '_blank' : undefined}
                rel={link.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label === 'GitHub' ? (
                  <span className="flex items-center gap-1.5">
                    <Github className="w-4 h-4" />
                    {link.label}
                  </span>
                ) : (
                  link.label
                )}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-6">
            <span className="text-sm text-muted-foreground">
              ©2026 KazCode
            </span>
            {legalLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
