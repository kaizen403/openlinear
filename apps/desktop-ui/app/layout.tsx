import type { Metadata } from "next"
import localFont from "next/font/local"
import "./globals.css"
import { AuthProvider } from "@/hooks/use-auth"
import { Toaster } from "sonner"

const geistSans = localFont({
  src: "./fonts/Geist-Variable.woff2",
  variable: "--font-geist-sans",
  display: "swap",
  weight: "100 900",
})

const geistMono = localFont({
  src: "./fonts/GeistMono-Variable.woff2",
  variable: "--font-geist-mono",
  display: "swap",
  weight: "100 900",
})

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
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <AuthProvider>
          {children}
          <Toaster position="bottom-right" theme="dark" />
        </AuthProvider>
      </body>
    </html>
  )
}
