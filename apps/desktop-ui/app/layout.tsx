import type { Metadata, Viewport } from "next"
import { DM_Mono, DM_Sans, EB_Garamond, Space_Grotesk } from "next/font/google"
import "./globals.css"
import { AuthProvider } from "@/hooks/use-auth"
import { SSEProvider } from "@/providers/sse-provider"
import { Toaster } from "sonner"
import { GlobalQuickCapture } from "@/components/global-quick-capture"
import { GodModeOverlay } from "@/components/god-mode-overlay"

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
})

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
})

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  variable: "--font-eb-garamond",
})

const dmMono = DM_Mono({
  subsets: ["latin"],
  variable: "--font-dm-mono",
  weight: ["400", "500"],
})

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export const metadata: Metadata = {
  title: "OpenLinear",
  description: "AI-powered issue tracking and code execution",
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
    <html
      lang="en"
      className={`dark ${spaceGrotesk.variable} ${dmSans.variable} ${ebGaramond.variable} ${dmMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <link rel="icon" href="/logo.png" type="image/png" />
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
          <SSEProvider>
            {children}
          </SSEProvider>
          <GlobalQuickCapture />
          <GodModeOverlay />
          <Toaster position="bottom-right" theme="dark" />
        </AuthProvider>
      </body>
    </html>
  )
}
