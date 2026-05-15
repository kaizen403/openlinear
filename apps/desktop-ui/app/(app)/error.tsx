"use client"

import { useEffect } from "react"
import { AlertTriangle, RotateCw } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    toast.error("Something went wrong", {
      description: "We hit an unexpected error. Try again, or reload the app.",
    })
    if (process.env.NODE_ENV === "development") {
      // eslint-disable-next-line no-console
      console.error("[error boundary]", error)
    }
  }, [error])

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-sm border border-border/60 bg-card p-8 shadow-lg">
        <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-sm bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h1 className="font-sans text-2xl font-semibold tracking-tight text-foreground">
          Something went wrong
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          An unexpected error occurred while loading this view. You can try again,
          or head back to the start.
        </p>
        {error.digest ? (
          <p className="mt-4 font-mono text-xs text-muted-foreground/70">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-2">
          <Button onClick={() => reset()} className="gap-2">
            <RotateCw className="h-4 w-4" />
            Try again
          </Button>
          <Button variant="outline" asChild>
            <a href="/">Go home</a>
          </Button>
        </div>
      </div>
    </div>
  )
}
