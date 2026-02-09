"use client"

import { useEffect, useState } from "react"

const COLUMNS = [
  { id: "todo", title: "Todo", cardCount: 3 },
  { id: "in_progress", title: "In Progress", cardCount: 2 },
  { id: "done", title: "Done", cardCount: 2 },
  { id: "cancelled", title: "Cancelled", cardCount: 1 },
]

function SkeletonColumn({
  title,
  cardCount,
  columnIndex,
}: {
  title: string
  cardCount: number
  columnIndex: number
}) {
  return (
    <div className="flex flex-col min-w-[300px] w-[300px] h-full opacity-0 animate-[fadeIn_0.5s_ease-out_forwards]" style={{ animationDelay: `${columnIndex * 100}ms` }}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="w-16 h-3 bg-[#2a2a2a] rounded animate-pulse" />
          <div className="w-6 h-4 bg-[#1f1f1f] rounded-full animate-pulse" style={{ animationDelay: "100ms" }} />
        </div>
        <div className="w-6 h-6 rounded bg-[#1f1f1f] animate-pulse" style={{ animationDelay: "150ms" }} />
      </div>

      <div className="flex-1 p-3 space-y-3">
        {Array.from({ length: cardCount }).map((_, cardIndex) => (
          <SkeletonCard
            key={cardIndex}
            columnIndex={columnIndex}
            cardIndex={cardIndex}
          />
        ))}
      </div>
    </div>
  )
}

function SkeletonCard({
  columnIndex,
  cardIndex,
}: {
  columnIndex: number
  cardIndex: number
}) {
  const delay = columnIndex * 100 + cardIndex * 150 + 200

  return (
    <div
      className="bg-[#141414] rounded-lg p-4 border border-[#2a2a2a] opacity-0 animate-[slideUp_0.6s_ease-out_forwards] relative overflow-hidden group"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className="absolute inset-0 bg-gradient-to-r from-transparent via-white/[0.03] to-transparent -translate-x-full animate-[shimmer_2s_infinite]"
        style={{ animationDelay: `${delay + 500}ms` }}
      />

      <div className="space-y-3 relative z-10">
        <div className="h-4 bg-[#2a2a2a] rounded animate-pulse w-3/4" style={{ animationDelay: `${delay + 50}ms` }} />

        <div className="space-y-2">
          <div className="h-3 bg-[#1f1f1f] rounded animate-pulse w-full" style={{ animationDelay: `${delay + 100}ms` }} />
          <div className="h-3 bg-[#1f1f1f] rounded animate-pulse w-2/3" style={{ animationDelay: `${delay + 150}ms` }} />
        </div>

        <div className="flex items-center justify-between pt-2">
          <div className="flex gap-2">
            <div className="w-12 h-5 bg-[#1f1f1f] rounded animate-pulse" style={{ animationDelay: `${delay + 200}ms` }} />
            <div className="w-14 h-5 bg-[#1f1f1f] rounded animate-pulse" style={{ animationDelay: `${delay + 250}ms` }} />
          </div>
          <div className="w-6 h-6 rounded-full bg-[#2a2a2a] animate-pulse" style={{ animationDelay: `${delay + 300}ms` }} />
        </div>
      </div>

      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none"
        style={{
          background: "radial-gradient(600px circle at var(--mouse-x, 50%) var(--mouse-y, 50%), rgba(59, 130, 246, 0.06), transparent 40%)",
        }}
      />
    </div>
  )
}

function FloatingShape({
  size,
  position,
  delay,
  duration,
}: {
  size: number
  position: { x: string; y: string }
  delay: number
  duration: number
}) {
  return (
    <div
      className="absolute rounded-full blur-3xl opacity-20 animate-[float_8s_ease-in-out_infinite]"
      style={{
        width: size,
        height: size,
        left: position.x,
        top: position.y,
        background: "radial-gradient(circle, var(--linear-accent, #3b82f6) 0%, transparent 70%)",
        animationDelay: `${delay}ms`,
        animationDuration: `${duration}s`,
      }}
    />
  )
}

function TracingLine() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      <div
        className="absolute top-1/2 left-0 h-[1px] animate-[traceLine_3s_ease-in-out_infinite]"
        style={{
          background: "linear-gradient(90deg, transparent, var(--linear-accent, #3b82f6), transparent)",
          boxShadow: "0 0 20px var(--linear-accent, #3b82f6), 0 0 40px var(--linear-accent, #3b82f6)",
        }}
      />

      {COLUMNS.map((_, index) => (
        <div
          key={index}
          className="absolute top-0 w-[1px] h-0 animate-[traceVertical_2s_ease-out_forwards]"
          style={{
            left: `${(index + 1) * 300 - 150}px`,
            background: "linear-gradient(180deg, var(--linear-accent, #3b82f6), transparent)",
            animationDelay: `${index * 300 + 1000}ms`,
            boxShadow: "0 0 10px var(--linear-accent, #3b82f6)",
          }}
        />
      ))}
    </div>
  )
}

function GridPattern() {
  return (
    <div
      className="absolute inset-0 opacity-[0.02]"
      style={{
        backgroundImage: `
          linear-gradient(rgba(255, 255, 255, 0.1) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.1) 1px, transparent 1px)
        `,
        backgroundSize: "40px 40px",
      }}
    />
  )
}

function LoadingText() {
  const [dots, setDots] = useState(0)

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => (prev + 1) % 4)
    }, 400)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 opacity-0 animate-[fadeIn_1s_ease-out_1.5s_forwards]">
      <div className="flex items-center gap-2">
        <div
          className="w-2 h-2 rounded-full animate-pulse"
          style={{
            backgroundColor: "var(--linear-accent, #3b82f6)",
            boxShadow: "0 0 10px var(--linear-accent, #3b82f6)",
          }}
        />
        <span className="text-[#6a6a6a] text-sm font-medium tracking-wide">
          Loading workspace{" ".repeat(dots).replace(/ /g, "\u00A0")}
        </span>
      </div>
      <div className="w-32 h-1 bg-[#1f1f1f] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full animate-[progressBar_2s_ease-in-out_infinite]"
          style={{
            background: "linear-gradient(90deg, var(--linear-accent, #3b82f6), #60a5fa)",
            boxShadow: "0 0 10px var(--linear-accent, #3b82f6)",
          }}
        />
      </div>
    </div>
  )
}

export function DashboardLoading() {
  return (
    <div className="flex-1 overflow-x-auto overflow-y-hidden relative bg-[#050505]">
      <style jsx>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes shimmer {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(200%);
          }
        }

        @keyframes float {
          0%, 100% {
            transform: translate(0, 0) scale(1);
          }
          25% {
            transform: translate(10px, -15px) scale(1.05);
          }
          50% {
            transform: translate(-5px, 10px) scale(0.95);
          }
          75% {
            transform: translate(15px, 5px) scale(1.02);
          }
        }

        @keyframes traceLine {
          0% {
            width: 0;
            left: 0;
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          90% {
            opacity: 1;
          }
          100% {
            width: 100%;
            left: 0;
            opacity: 0;
          }
        }

        @keyframes traceVertical {
          from {
            height: 0;
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          to {
            height: 100%;
            opacity: 0.3;
          }
        }

        @keyframes progressBar {
          0% {
            width: 0;
            transform: translateX(0);
          }
          50% {
            width: 100%;
            transform: translateX(0);
          }
          100% {
            width: 100%;
            transform: translateX(100%);
          }
        }

        @keyframes pulse {
          0%, 100% {
            opacity: 0.4;
          }
          50% {
            opacity: 0.7;
          }
        }

        @keyframes breathe {
          0%, 100% {
            transform: scale(1);
            opacity: 0.8;
          }
          50% {
            transform: scale(1.02);
            opacity: 1;
          }
        }
      `}</style>

      <GridPattern />

      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <FloatingShape size={400} position={{ x: "10%", y: "20%" }} delay={0} duration={10} />
        <FloatingShape size={300} position={{ x: "70%", y: "60%" }} delay={2000} duration={12} />
        <FloatingShape size={250} position={{ x: "40%", y: "70%" }} delay={1000} duration={8} />
        <FloatingShape size={350} position={{ x: "80%", y: "10%" }} delay={3000} duration={11} />
      </div>

      <TracingLine />

      <div
        className="flex gap-6 h-full p-6 min-w-max animate-[breathe_4s_ease-in-out_infinite]"
        style={{ animationDelay: "2s" }}
      >
        {COLUMNS.map((column, index) => (
          <SkeletonColumn
            key={column.id}
            title={column.title}
            cardCount={column.cardCount}
            columnIndex={index}
          />
        ))}
      </div>

      <LoadingText />

      <div
        className="absolute inset-0 pointer-events-none opacity-30"
        style={{
          background: "radial-gradient(ellipse at 50% 0%, rgba(59, 130, 246, 0.1), transparent 50%)",
        }}
      />
    </div>
  )
}
