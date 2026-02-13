"use client"

const COLUMNS = [
  { id: "todo", title: "Todo", cardCount: 3 },
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
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-16 h-3 bg-[#2a2a2a] rounded" />
          <div className="w-6 h-4 bg-[#1f1f1f] rounded-full" />
        </div>
        <div className="w-6 h-6 rounded bg-[#1f1f1f]" />
      </div>

      <div className="flex-1 p-3 space-y-3">
        {Array.from({ length: cardCount }).map((_, cardIndex) => (
          <SkeletonCard key={cardIndex} />
        ))}
      </div>
    </div>
  )
}

function SkeletonCard() {
  return (
    <div className="bg-[#141414] rounded-lg p-4 border border-[#2a2a2a]">
      <div className="space-y-3">
        <div className="h-4 bg-[#2a2a2a] rounded w-3/4" />

        <div className="space-y-2">
          <div className="h-3 bg-[#1f1f1f] rounded w-full" />
          <div className="h-3 bg-[#1f1f1f] rounded w-2/3" />
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            <div className="w-12 h-5 bg-[#1f1f1f] rounded" />
            <div className="w-14 h-5 bg-[#1f1f1f] rounded" />
          </div>
          <div className="w-6 h-6 rounded-full bg-[#2a2a2a]" />
        </div>
      </div>
    </div>
  )
}

export function DashboardLoading() {
  return (
    <div className="flex-1 overflow-hidden relative bg-[#111111]">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 h-full">
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
