'use client'

import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'

interface CodeBlockProps {
  children: string
  language?: string
  filename?: string
  className?: string
}

export function CodeBlock({ children, language, filename, className }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(children)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <div className={cn('group relative my-6 overflow-hidden rounded-xl border border-border/60 bg-[#0a0f1a]/70', className)}>
      {(filename || language) && (
        <div className="flex items-center justify-between border-b border-border/40 px-4 py-2 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            {filename && <span className="font-mono">{filename}</span>}
            {language && !filename && <span className="uppercase tracking-wider opacity-70">{language}</span>}
          </div>
        </div>
      )}
      <button
        onClick={copy}
        className="absolute right-2 top-2 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.04] text-muted-foreground opacity-0 transition-all hover:bg-white/[0.08] hover:text-white group-hover:opacity-100"
        style={{ top: filename || language ? '0.6rem' : '0.6rem' }}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <pre className="overflow-x-auto px-4 py-3.5 text-[0.825rem] leading-relaxed">
        <code className="font-mono text-foreground/90">{children}</code>
      </pre>
    </div>
  )
}
