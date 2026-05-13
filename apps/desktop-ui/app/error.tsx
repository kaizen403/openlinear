"use client"

import { useEffect } from "react"
import Link from "next/link"
import { AlertTriangle, RotateCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    toast.error("Something went wrong", {
      description: "Try again, or reload OpenLinear if the problem persists.",
    })
    if (process.env.NODE_ENV === "development") {
      console.error("[root error boundary]", error)
    }
  }, [error])

  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-linear-bg p-6 text-linear-text">
      <div className="w-full max-w-md rounded-sm border border-linear-border bg-linear-bg-secondary p-8 shadow-overlay">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-sm bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="font-sans text-2xl font-semibold tracking-tight">
          OpenLinear hit an error
        </h1>
        <p className="mt-2 text-sm text-linear-text-secondary">
          The app failed to render this screen. Try again to recover the current
          route, or return home.
        </p>
        {error.digest ? (
          <p className="mt-4 font-mono text-xs text-linear-text-tertiary">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={() => reset()} className="gap-2">
            <RotateCw className="h-4 w-4" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <Link href="/">Go home</Link>
          </Button>
        </div>
      </div>
    </main>
  )
}
