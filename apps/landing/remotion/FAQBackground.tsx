import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion"

const W = 1920
const H = 1080
const TOTAL_FRAMES = 360

const CORE_X = W / 2
const CORE_Y = 210

const SEC_X = 1580
const SEC_Y = 855

const RING_MAX_R = 790
const RING_STAGGER = 120
const GRID_RADIUS = 970

const RINGS = [
  { id: "ring-0", color: "59, 130, 246",  stagger: 0 },
  { id: "ring-1", color: "139, 92, 246",  stagger: RING_STAGGER },
  { id: "ring-2", color: "59, 130, 246",  stagger: RING_STAGGER * 2 },
]

const GRID_LINES = Array.from({ length: 10 }, (_, i) => ({
  id: `gl-base-${i}`,
  baseAngle: (i / 10) * Math.PI * 2,
}))

// Golden-angle spread: multiplier 2.39996 rad ≈ 137.5° prevents clustering.
// `cycles` is always a positive integer so that
//   ((frame / TOTAL_FRAMES + phase) * cycles) % 1
// returns the same value at frame 0 and frame TOTAL_FRAMES → seamless loop.
const PARTICLES = Array.from({ length: 25 }, (_, i) => {
  const angle = (i * 2.39996) % (Math.PI * 2)
  const dist = 290 + ((i * 211) % 610)
  const x0 = CORE_X + Math.cos(angle) * dist
  const y0 = CORE_Y + Math.sin(angle) * dist
  return {
    id: `pt-${Math.round(x0)}-${Math.round(y0)}`,
    x0,
    y0,
    cycles: i % 3 === 0 ? 2 : 1,
    phase: i / 25,
    size: 0.9 + (i % 4) * 0.45,
    alpha: 0.12 + (i % 6) * 0.05,
  }
})

// Prime-step LCG: gcd(1277, W) = 1 and gcd(743, H) = 1 → full W×H coverage
// across 220 dots with no repeats.
const GRAIN = Array.from({ length: 220 }, (_, i) => ({
  id: `gr-${i}`,
  x: (i * 1277 + 37) % W,
  y: (i * 743 + 97) % H,
  r: 0.35 + (i % 5) * 0.25,
}))

export const FAQBackground: React.FC = () => {
  const frame = useCurrentFrame()

  const breatheSin = Math.sin((frame / 180) * Math.PI * 2)
  const glowScale = 1.0 + breatheSin * 0.2
  const glowOpacity = 0.20 + breatheSin * 0.05

  const secSin = Math.sin((frame / 360) * Math.PI * 2)
  const secRadius = 330 * (1.0 + secSin * 0.12)
  const secOpacity = 0.125 + secSin * 0.025

  const gridRad = (frame * 0.1 * Math.PI) / 180

  return (
    <AbsoluteFill style={{ backgroundColor: "hsl(0 0% 3.9%)" }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        style={{ position: "absolute", inset: 0 }}
        role="presentation"
        aria-hidden={true}
      >
        <defs>
          <filter id="faq-blur-heavy" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="65" />
          </filter>
          <filter id="faq-blur-med" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="80" />
          </filter>
          <filter id="faq-blur-ring" x="-5%" y="-5%" width="110%" height="110%">
            <feGaussianBlur stdDeviation="1.5" />
          </filter>
        </defs>

        <circle
          cx={CORE_X}
          cy={CORE_Y}
          r={400 * glowScale}
          fill={`rgba(59, 130, 246, ${glowOpacity})`}
          filter="url(#faq-blur-heavy)"
        />

        {RINGS.map((ring) => {
          const ringFrame =
            ((frame - ring.stagger) % TOTAL_FRAMES + TOTAL_FRAMES) %
            TOTAL_FRAMES
          const progress = ringFrame / TOTAL_FRAMES
          const radius = interpolate(progress, [0, 1], [8, RING_MAX_R], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
          const opacity = interpolate(
            progress,
            [0, 0.05, 0.60, 1.0],
            [0, 0.85, 0.22, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
          const sw = interpolate(progress, [0, 0.08, 1.0], [2.5, 1.8, 0.4], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
          return (
            <circle
              key={ring.id}
              cx={CORE_X}
              cy={CORE_Y}
              r={radius}
              fill="none"
              stroke={`rgba(${ring.color}, ${opacity})`}
              strokeWidth={sw}
              filter="url(#faq-blur-ring)"
            />
          )
        })}

        <circle
          cx={SEC_X}
          cy={SEC_Y}
          r={secRadius}
          fill={`rgba(99, 102, 241, ${secOpacity})`}
          filter="url(#faq-blur-med)"
        />

        {GRID_LINES.map((line) => {
          const a = line.baseAngle + gridRad
          const lo = 0.030 + Math.abs(Math.sin(a * 2.5)) * 0.018
          return (
            <line
              key={line.id}
              x1={CORE_X}
              y1={CORE_Y}
              x2={CORE_X + Math.cos(a) * GRID_RADIUS}
              y2={CORE_Y + Math.sin(a) * GRID_RADIUS}
              stroke={`rgba(99, 102, 241, ${lo})`}
              strokeWidth={0.5}
            />
          )
        })}

        {PARTICLES.map((p) => {
          const t = ((frame / TOTAL_FRAMES + p.phase) * p.cycles) % 1
          const px = p.x0 + (CORE_X - p.x0) * t
          const py = p.y0 + (CORE_Y - p.y0) * t
          const vis = interpolate(
            t,
            [0, 0.06, 0.78, 1.0],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
          const ex = px / W
          const ey = py / H
          const edgeFade = Math.min(
            ex < 0.06 ? ex / 0.06 : ex > 0.94 ? (1 - ex) / 0.06 : 1,
            ey < 0.06 ? ey / 0.06 : ey > 0.94 ? (1 - ey) / 0.06 : 1,
          )
          return (
            <circle
              key={p.id}
              cx={px}
              cy={py}
              r={p.size}
              fill={`rgba(148, 163, 184, ${p.alpha * vis * edgeFade})`}
            />
          )
        })}

        {GRAIN.map((dot) => (
          <circle
            key={dot.id}
            cx={dot.x}
            cy={dot.y}
            r={dot.r}
            fill="rgba(255, 255, 255, 0.020)"
          />
        ))}
      </svg>

      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 130,
          background:
            "linear-gradient(to bottom, hsl(0 0% 3.9%) 0%, transparent 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 220,
          background:
            "linear-gradient(to top, hsl(0 0% 3.9%) 0%, transparent 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: 160,
          background:
            "linear-gradient(to right, hsl(0 0% 3.9%) 0%, transparent 100%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 160,
          background:
            "linear-gradient(to left, hsl(0 0% 3.9%) 0%, transparent 100%)",
        }}
      />
    </AbsoluteFill>
  )
}

export default FAQBackground
