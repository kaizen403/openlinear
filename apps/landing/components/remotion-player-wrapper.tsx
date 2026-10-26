"use client"

import { Player } from "@remotion/player"
import { useCallback, useEffect, useRef, useState } from "react"

const MOBILE_BREAKPOINT = 768

function usePrefersReducedMotion() {
  const [prefersReduced, setPrefersReduced] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)")
    setPrefersReduced(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setPrefersReduced(e.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return prefersReduced
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    setIsMobile(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}

interface RemotionPlayerWrapperProps {
  lazyComponent: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>
  durationInFrames: number
  compositionWidth?: number
  compositionHeight?: number
  fps?: number
  mode?: "background" | "inline"
  aspectRatio?: string
  inputProps?: Record<string, unknown>
  className?: string
  style?: React.CSSProperties
}

export function RemotionPlayerWrapper({
  lazyComponent,
  durationInFrames,
  compositionWidth = 1920,
  compositionHeight = 1080,
  fps = 30,
  mode = "inline",
  aspectRatio,
  inputProps,
  className = "",
  style,
}: RemotionPlayerWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [hasBeenVisible, setHasBeenVisible] = useState(false)
  const prefersReducedMotion = usePrefersReducedMotion()
  const isMobile = useIsMobile()

  const stableLazyComponent = useCallback(lazyComponent, [lazyComponent])

  const effectiveFps = isMobile ? 15 : fps

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setHasBeenVisible(true)
          observer.unobserve(el)
        }
      },
      { threshold: 0.05, rootMargin: "200px" }
    )

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const isBackground = mode === "background"

  const containerStyle: React.CSSProperties = isBackground
    ? {
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        ...style,
      }
    : {
        width: "100%",
        overflow: "hidden",
        borderRadius: "12px",
        aspectRatio: aspectRatio ?? `${compositionWidth} / ${compositionHeight}`,
        ...style,
      }

  return (
    <div ref={containerRef} className={className} style={containerStyle}>
      {hasBeenVisible && !prefersReducedMotion && (
        <Player
          lazyComponent={stableLazyComponent}
          durationInFrames={durationInFrames}
          compositionWidth={compositionWidth}
          compositionHeight={compositionHeight}
          fps={effectiveFps}
          autoPlay
          loop
          controls={false}
          clickToPlay={false}
          doubleClickToFullscreen={false}
          allowFullscreen={false}
          initiallyMuted
          inputProps={inputProps}
          style={{
            width: "100%",
            height: "100%",
          }}
        />
      )}
    </div>
  )
}
