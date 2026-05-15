import Link from "next/link"
import { Compass } from "lucide-react"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-sm border border-border/60 bg-muted/40 text-muted-foreground">
          <Compass className="h-6 w-6" />
        </div>
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
          404
        </p>
        <h2 className="mt-2 font-sans text-2xl font-semibold tracking-tight text-foreground">
          Not found in Settings
        </h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          We couldn't find what you were looking for here.
        </p>
        <div className="mt-5 flex justify-center gap-2">
          <Button asChild size="sm">
            <Link href="/">Back to home</Link>
          </Button>
        </div>
      </div>
    </div>
  )
}
