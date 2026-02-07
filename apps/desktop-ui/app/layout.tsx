import type { Metadata } from "next"
import { GeistSans } from "geist/font/sans"
import { GeistMono } from "geist/font/mono"
import "./globals.css"
import { AuthProvider } from "@/hooks/use-auth"
import { Toaster } from "sonner"

export const metadata: Metadata = {
  title: "OpenLinear - Linear Clone",
  description: "A Linear-inspired issue tracking application",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans antialiased`}>
        <AuthProvider>
          {children}
          <Toaster position="bottom-right" theme="dark" />
        </AuthProvider>
      </body>
    </html>
  )
}
