import type { Metadata, Viewport } from "next"
import "./globals.css"
import { ThemeProvider } from "next-themes"
import { AuthProvider } from "@/hooks/use-auth"
import { SSEProvider } from "@/providers/sse-provider"
import { TeamsProvider } from "@/providers/teams-provider"
import { ThemedToaster } from "@/components/themed-toaster"
import { ThemeMeta } from "@/components/theme-meta"
import { GlobalQuickCapture } from "@/components/global-quick-capture"
import { GodModeOverlay } from "@/components/god-mode-overlay"
import { CommandPalette } from "@/components/command-palette"
import { ShortcutsOverlay } from "@/components/shortcuts-overlay"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export const metadata: Metadata = {
  title: "OpenLinear",
  description: "AI-powered project management that actually writes the code.",
  metadataBase: new URL("https://openlinear.tech"),
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: ["/favicon.ico"],
  },
  openGraph: {
    title: "OpenLinear",
    description: "AI-powered project management that actually writes the code.",
    url: "https://openlinear.tech",
    siteName: "OpenLinear",
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "OpenLinear" }],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "OpenLinear",
    description: "Drag tasks. Click execute. Get a pull request.",
    images: ["/twitter-card.png"],
  },
  other: {
    "theme-color": "#0a0a0a",
    "color-scheme": "dark",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem("openlinear-accent");if(s){var c=JSON.parse(s);document.documentElement.style.setProperty("--linear-accent",c.accent);document.documentElement.style.setProperty("--linear-accent-hover",c.hover)}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <ThemeMeta />
          <AuthProvider>
            <SSEProvider>
              <TeamsProvider>
                {children}
              </TeamsProvider>
            </SSEProvider>
            <GlobalQuickCapture />
            <GodModeOverlay />
            <CommandPalette />
            <ShortcutsOverlay />
            <ThemedToaster />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
