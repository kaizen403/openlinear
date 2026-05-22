import type { Metadata } from 'next'
import localFont from 'next/font/local'
import { ThemeProvider } from '@/components/theme-provider'
import { Header } from '@/components/header'
import { Sidebar } from '@/components/sidebar'
import { Footer } from '@/components/footer'

import './globals.css'

const anthropicSans = localFont({
  src: [
    { path: '../public/fonts/anthropic-sans-400.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/anthropic-sans-500.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/anthropic-sans-600.woff2', weight: '600', style: 'normal' },
    { path: '../public/fonts/anthropic-sans-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-anthropic-sans',
  display: 'swap',
})

const geistSans = localFont({
  src: [
    { path: '../public/fonts/geist-sans-400.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/geist-sans-500.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/geist-sans-600.woff2', weight: '600', style: 'normal' },
    { path: '../public/fonts/geist-sans-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-geist-sans',
  display: 'swap',
})

const geistMono = localFont({
  src: [
    { path: '../public/fonts/geist-mono-400.woff2', weight: '400', style: 'normal' },
    { path: '../public/fonts/geist-mono-500.woff2', weight: '500', style: 'normal' },
    { path: '../public/fonts/geist-mono-700.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-geist-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'OpenLinear MCP — Documentation',
  description:
    'Use OpenLinear from any MCP-compatible AI client. Plan projects, create phases, and bulk-create issues with a single tool call.',
  metadataBase: new URL('https://openlinear.tech'),
  openGraph: {
    title: 'OpenLinear MCP — Documentation',
    description:
      'The Model Context Protocol server for OpenLinear. Turn an AI-generated plan into a fully populated dashboard in one call.',
    siteName: 'OpenLinear MCP Docs',
    type: 'website',
  },
  other: {
    'theme-color': '#0a0a0a',
    'color-scheme': 'dark',
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${anthropicSans.variable} ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" forcedTheme="dark" disableTransitionOnChange>
          <div className="relative min-h-screen">
            {/* subtle background grid */}
            <div
              aria-hidden
              className="pointer-events-none fixed inset-0 -z-10 opacity-[0.025]"
              style={{
                backgroundImage:
                  'linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)',
                backgroundSize: '64px 64px',
                maskImage: 'radial-gradient(ellipse at center, black 50%, transparent 80%)',
              }}
            />
            <Header />
            <div className="mx-auto flex max-w-[1280px] gap-10 px-6 pt-24 lg:px-10">
              <Sidebar />
              <main className="min-w-0 flex-1 py-6">{children}</main>
            </div>
            <Footer />
          </div>
        </ThemeProvider>
      </body>
    </html>
  )
}
