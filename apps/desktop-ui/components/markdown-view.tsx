"use client"

import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn, openExternal } from "@/lib/utils"

interface MarkdownViewProps {
  body: string
  className?: string
}

// Inline component map keeps markdown rendering consistent with the Linear-inspired
// dark theme (no @tailwindcss/typography plugin in this app). ReactMarkdown sanitizes
// HTML by default — we intentionally do NOT enable rehype-raw to avoid XSS.
const components: Components = {
  h1: ({ children, ...props }) => (
    <h1 className="text-xl font-semibold text-linear-text mt-4 mb-2 first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="text-lg font-semibold text-linear-text mt-4 mb-2 first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-base font-medium text-linear-text mt-3 mb-2 first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="text-sm font-medium text-linear-text mt-3 mb-1 first:mt-0" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p className="text-sm text-linear-text-secondary leading-relaxed mb-3 last:mb-0" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="list-disc list-outside ml-5 mb-3 space-y-1 text-sm text-linear-text-secondary" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal list-outside ml-5 mb-3 space-y-1 text-sm text-linear-text-secondary" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  code: ({ children, className, ...props }) => {
    // Inline code (no language class). Block code is handled by `pre`.
    const isBlock = className?.startsWith("language-")
    if (isBlock) {
      return (
        <code className={cn("font-mono text-xs", className)} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code
        className="font-mono text-[0.85em] px-1 py-0.5 rounded bg-linear-bg-secondary border border-linear-border text-linear-text"
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ children, ...props }) => (
    <pre
      className="font-mono text-xs p-3 mb-3 rounded-sm bg-linear-bg-secondary border border-linear-border text-linear-text overflow-x-auto"
      {...props}
    >
      {children}
    </pre>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-linear-text" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      className="text-linear-accent hover:underline"
      onClick={(e) => {
        // Route links through the Tauri shell so they open in the system browser
        // instead of navigating the embedded webview.
        if (href) {
          e.preventDefault()
          e.stopPropagation()
          openExternal(href)
        }
      }}
      {...props}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="border-l-2 border-linear-border pl-3 my-3 text-sm text-linear-text-tertiary italic"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props) => <hr className="my-4 border-linear-border" {...props} />,
  table: ({ children, ...props }) => (
    <div className="overflow-x-auto mb-3">
      <table className="text-sm border-collapse border border-linear-border" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }) => (
    <th className="border border-linear-border px-2 py-1 text-left font-medium text-linear-text bg-linear-bg-secondary" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-linear-border px-2 py-1 text-linear-text-secondary" {...props}>
      {children}
    </td>
  ),
}

export function MarkdownView({ body, className }: MarkdownViewProps) {
  return (
    <div className={cn("text-sm text-linear-text-secondary", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  )
}
