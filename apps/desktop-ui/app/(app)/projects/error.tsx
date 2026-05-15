"use client"

import { useEffect } from "react"
import { AlertTriangle, RotateCw } from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"

export default function SectionError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    toast.error("Couldn't load Projects", {
      description: "Something went wrong. Try again in a moment.",
    })
  }, [error])

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-md rounded-sm border border-border/60 bg-card p-7 shadow-sm">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-sm bg-destructive/10 text-destructive">
          <AlertTriangle className="h-5 w-5" />
        </div>
        <h2 className="font-sans text-xl font-semibold tracking-tight text-foreground">
          Couldn't load Projects
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          We hit an unexpected error loading this section. Try again, or head
          back home.
        </p>
        {error.digest ? (
          <p className="mt-3 font-mono text-xs text-muted-foreground/70">
            ref: {error.digest}
          </p>
        ) : null}
        <div className="mt-5 flex gap-2">
          <Button onClick={() => reset()} className="gap-2" size="sm">
            <RotateCw className="h-3.5 w-3.5" />
            Try again
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/">Go home</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
