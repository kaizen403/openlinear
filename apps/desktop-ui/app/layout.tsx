import type { Metadata, Viewport } from "next"
import "./globals.css"
import { ThemeProvider } from "next-themes"
import { AuthProvider } from "@/hooks/use-auth"
import { SSEProvider } from "@/providers/sse-provider"
import { TeamsProvider } from "@/providers/teams-provider"
import { WorkspaceProvider } from "@/hooks/use-workspace"
import { ProjectProvider } from "@/hooks/use-project"
import { ChatSessionsProvider } from "@/hooks/use-chat-sessions"
import { ChatScopeProvider } from "@/hooks/use-chat-scope"
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
            __html: `(function(){try{var d=document.documentElement;var defaults={accent:"#10b981",hover:"#059669"};var legacy={"#1d4ed8":1,"#1e40af":1,"#3b82f6":1,"#2563eb":1};var s=localStorage.getItem("openlinear-accent");if(s){var c=JSON.parse(s);if(legacy[String(c.accent).toLowerCase()]||legacy[String(c.hover).toLowerCase()]){c=defaults;localStorage.setItem("openlinear-accent",JSON.stringify(c))}d.style.setProperty("--linear-accent",c.accent);d.style.setProperty("--linear-accent-hover",c.hover)}var tauri=!!window.__TAURI_INTERNALS__;var platform=(navigator.platform||navigator.userAgent||"").toLowerCase();var linux=platform.indexOf("linux")!==-1||platform.indexOf("x11")!==-1;d.dataset.openlinearRuntime=tauri?"tauri":"web";d.dataset.openlinearPlatform=linux?"linux":"other";var profile=localStorage.getItem("openlinear-render-profile");d.dataset.openlinearRenderProfile=profile||(tauri&&linux?"fast":"default")}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-ui antialiased">
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <ThemeMeta />
          <AuthProvider>
            <SSEProvider>
              <WorkspaceProvider>
                <TeamsProvider>
                  <ProjectProvider>
                    <ChatScopeProvider>
                      <ChatSessionsProvider>
                        {children}
                        <GlobalQuickCapture />
                      </ChatSessionsProvider>
                    </ChatScopeProvider>
                  </ProjectProvider>
                </TeamsProvider>
              </WorkspaceProvider>
            </SSEProvider>
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
