import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'KazCode | The kanban board that codes for you',
  description: 'KazCode is an open source desktop app that combines a Linear-style kanban board with AI coding agents. Create tasks, organize them on a board, and execute them — the AI clones your repo, creates a branch, writes code, and opens a pull request.',
  keywords: ['kanban', 'AI coding', 'developer tools', 'task management', 'GitHub integration'],
  authors: [{ name: 'KazCode' }],
  openGraph: {
    title: 'KazCode | The kanban board that codes for you',
    description: 'KazCode is an open source desktop app that combines a Linear-style kanban board with AI coding agents.',
    type: 'website',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased min-h-screen">
        {children}
      </body>
    </html>
  )
}
