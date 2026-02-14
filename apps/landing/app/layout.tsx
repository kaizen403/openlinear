import type { Metadata } from 'next'
import { Space_Grotesk } from 'next/font/google'
import { ThemeProvider } from '@/components/theme-provider'

import './globals.css'

const _spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
})

export const metadata: Metadata = {
  title: 'OpenLinear - Execute your tasks. Don\'t just track them.',
  description: 'A desktop kanban board that runs AI coding agents on your GitHub repository. Create tasks, execute them, and review real pull requests.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`dark ${_spaceGrotesk.variable}`} suppressHydrationWarning>
      <body className="font-sans antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          forcedTheme="dark"
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
