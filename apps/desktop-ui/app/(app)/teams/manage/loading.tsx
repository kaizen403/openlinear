import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <div className="flex h-full w-full flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="ml-auto h-7 w-24" />
      </div>
      <Skeleton className="h-4 w-80" />
      <div className="mt-2 flex flex-col gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  )
}
