import type { Metadata, Viewport } from "next"
import "./globals.css"
import { ThemeProvider } from "next-themes"
import { AuthProvider } from "@/hooks/use-auth"
import { SSEProvider } from "@/providers/sse-provider"
import { QueryProvider, QuerySseBridge } from "@/providers/query-provider"
import { TeamsProvider } from "@/providers/teams-provider"
import { WorkspaceProvider } from "@/hooks/use-workspace"
import { ProjectProvider } from "@/hooks/use-project"
import { ChatSessionsProvider } from "@/hooks/use-chat-sessions"
import { ChatScopeProvider } from "@/hooks/use-chat-scope"
import { ChatPanelHandoffProvider } from "@/hooks/use-chat-panel-handoff"
import { ThemedToaster } from "@/components/themed-toaster"
import { ThemeMeta } from "@/components/theme-meta"
import { BrainstormPopup } from "@/components/brainstorm/brainstorm-popup"
import { GodModeOverlay } from "@/components/god-mode-overlay"
import { CommandPalette } from "@/components/command-palette"
import { ShortcutsOverlay } from "@/components/shortcuts-overlay"
import { WebVitalsReporter } from "@/components/web-vitals-reporter"
import { accentBootScript } from "@/lib/design/accent-migration"

// Applies (and migrates) the saved accent before first paint; generated from
// lib/design so the presets, the legacy-choice map and the defaults live in
// one place (see lib/design/accent-migration.ts).
const ACCENT_BOOT_SCRIPT = accentBootScript()

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
            __html: `(function(){${ACCENT_BOOT_SCRIPT}try{var d=document.documentElement;var tauri=!!window.__TAURI_INTERNALS__;var platform=(navigator.platform||navigator.userAgent||"").toLowerCase();var linux=platform.indexOf("linux")!==-1||platform.indexOf("x11")!==-1;d.dataset.openlinearRuntime=tauri?"tauri":"web";d.dataset.openlinearPlatform=linux?"linux":"other";var profile=localStorage.getItem("openlinear-render-profile");d.dataset.openlinearRenderProfile=profile||((tauri&&linux)?"fast":"default")
}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-ui antialiased">
        <WebVitalsReporter />
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
          <ThemeMeta />
          <QueryProvider>
            <AuthProvider>
              <SSEProvider>
                <QuerySseBridge />
                <WorkspaceProvider>
                  <TeamsProvider>
                    <ProjectProvider>
                      <ChatScopeProvider>
                        <ChatSessionsProvider>
                          <ChatPanelHandoffProvider>
                            {children}
                            <BrainstormPopup />
                            <GodModeOverlay />
                          </ChatPanelHandoffProvider>
                        </ChatSessionsProvider>
                      </ChatScopeProvider>
                    </ProjectProvider>
                  </TeamsProvider>
                </WorkspaceProvider>
              </SSEProvider>
              <CommandPalette />
              <ShortcutsOverlay />
              <ThemedToaster />
            </AuthProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
