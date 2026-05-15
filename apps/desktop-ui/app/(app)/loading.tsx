import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <aside className="hidden w-60 shrink-0 flex-col gap-4 border-r border-border/40 bg-muted/20 p-4 md:flex">
        <Skeleton className="h-8 w-32" />
        <div className="flex flex-col gap-2 pt-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-3/4" />
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex h-12 items-center gap-3 border-b border-border/40 px-4">
          <Skeleton className="h-5 w-40" />
          <div className="ml-auto flex gap-2">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-7 rounded-full" />
          </div>
        </header>
        <div className="flex-1 space-y-3 p-6">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-96" />
          <div className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full" />
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}
