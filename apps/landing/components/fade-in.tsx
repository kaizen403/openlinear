"use client"

import { useEffect, useRef, useState } from "react"

export function FadeIn({
  children,
  className = "",
}: {
  children: React.ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [shouldAnimate, setShouldAnimate] = useState(false)
  const hasStartedOffscreen = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldAnimate(hasStartedOffscreen.current)
          observer.unobserve(el)
        } else {
          hasStartedOffscreen.current = true
        }
      },
      { threshold: 0.1 }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      ref={ref}
      className={`${className} ${shouldAnimate ? "motion-safe:animate-fade-up" : ""}`.trim()}
    >
      {children}
    </div>
  )
}
