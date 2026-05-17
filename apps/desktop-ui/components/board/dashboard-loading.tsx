"use client"

const COLUMNS = [
  { id: "todo", title: "All Issues", cardCount: 3 },
  { id: "in_progress", title: "In Progress", cardCount: 2 },
  { id: "done", title: "Done", cardCount: 2 },
  { id: "cancelled", title: "Cancelled", cardCount: 1 },
]

function SkeletonColumn({
  title,
  cardCount,
}: {
  title: string
  cardCount: number
}) {
  return (
    <div className="flex flex-col h-full border-r border-linear-border last:border-r-0 w-[85vw] flex-none md:w-full md:flex-auto snap-start">
      <div className="flex items-center justify-between px-4 py-3 h-12 flex-shrink-0 border-b border-linear-border gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-shrink overflow-hidden">
          <div className="w-16 h-3 bg-linear-border rounded flex-shrink-0" />
          <div className="w-6 h-4 bg-linear-bg-tertiary rounded-full flex-shrink-0" />
        </div>
        <div className="w-6 h-6 rounded bg-linear-bg-tertiary flex-shrink-0" />
      </div>

      <div className="flex-1 p-3 space-y-3 overflow-y-auto">
        {Array.from({ length: cardCount }).map((_, cardIndex) => (
          <SkeletonCard key={cardIndex} />
        ))}
      </div>
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="bg-linear-bg-secondary rounded-sm p-4 border border-linear-border">
      <div className="space-y-3">
        <div className="h-4 bg-linear-border rounded w-3/4" />

        <div className="space-y-2">
          <div className="h-3 bg-linear-bg-tertiary rounded w-full" />
          <div className="h-3 bg-linear-bg-tertiary rounded w-2/3" />
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            <div className="w-12 h-5 bg-linear-bg-tertiary rounded" />
            <div className="w-14 h-5 bg-linear-bg-tertiary rounded" />
          </div>
          <div className="w-6 h-6 rounded-full bg-linear-border" />
        </div>
      </div>
    </div>
  )
}

export function DashboardLoading() {
  return (
    <div className="flex-1 overflow-hidden relative bg-linear-bg flex flex-col">
      <div className="flex md:grid md:grid-cols-2 lg:grid-cols-4 flex-1 min-h-0 overflow-x-auto snap-x snap-mandatory md:overflow-x-visible md:snap-none">
        {COLUMNS.map((column) => (
          <SkeletonColumn
            key={column.id}
            title={column.title}
            cardCount={column.cardCount}
          />
        ))}
      </div>
    </div>
  )
}
