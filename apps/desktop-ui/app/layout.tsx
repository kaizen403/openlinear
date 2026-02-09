import type { Metadata, Viewport } from "next"
import "./globals.css"
import { AuthProvider } from "@/hooks/use-auth"
import { Toaster } from "sonner"
import { GlobalQuickCapture } from "@/components/global-quick-capture"
import { GodModeOverlay } from "@/components/god-mode-overlay"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export const metadata: Metadata = {
  title: "OpenLinear - Linear Clone",
  description: "A Linear-inspired issue tracking application",
  other: {
    "theme-color": "#111111",
    "color-scheme": "dark",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600&display=swap" rel="stylesheet" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var s=localStorage.getItem("openlinear-accent");if(s){var c=JSON.parse(s);document.documentElement.style.setProperty("--linear-accent",c.accent);document.documentElement.style.setProperty("--linear-accent-hover",c.hover)}}catch(e){}})()`,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <AuthProvider>
          {children}
          <GlobalQuickCapture />
          <GodModeOverlay />
          <Toaster position="bottom-right" theme="dark" />
        </AuthProvider>
      </body>
    </html>
  )
}
