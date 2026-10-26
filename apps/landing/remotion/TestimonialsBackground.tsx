import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion"

// ── Scene constants ───────────────────────────────────────────────────────────
const W = 1920
const H = 1080
const TOTAL_FRAMES = 600 // 20-second loop at 30 fps

// Normalised TAU used as the angular period for seamless looping.
// All sine/cosine frequencies are expressed as integer multiples of TAU/TOTAL_FRAMES
// so sin(t * N) at frame 0 and frame TOTAL_FRAMES are identical.
const TAU = Math.PI * 2

// ── Aurora band definitions ───────────────────────────────────────────────────
// waveCycles   – integer: how many times the wave pattern scrolls per loop
// vertCycles   – integer: how many vertical drift cycles per loop
// spatialFreq  – wave peaks visible across the width (non-integer is fine here;
//                the POSITION of the wave is what must be integer-cycled, not the shape)
// All integer-cycle properties ensure the SVG path is identical at frame 0 and 600.

type AuroraBand = {
  id: string
  centerY: number    // fractional position in [0,1] relative to H
  bandH: number      // full band height in px (before blur)
  color: string      // "r, g, b"
  fill: number       // fill opacity  — kept low so it stays a background
  blur: number       // Gaussian blur stdDeviation
  waveCycles: number // integer — horizontal wave-scroll cycles per TOTAL_FRAMES
  undulAmp: number   // wave vertical amplitude in px
  spatialFreq: number // spatial wave frequency (waves-per-width)
  vertCycles: number // integer — vertical drift cycles per TOTAL_FRAMES
  vertAmp: number    // vertical drift amplitude as fraction of H
  phase: number      // radians — phase offset (staggers bands from each other)
}

const AURORA_BANDS: AuroraBand[] = [
  {
    id: "blue",
    centerY: 0.37,
    bandH: 218,
    color: "59, 130, 246",   // brand blue  #3b82f6
    fill: 0.20,
    blur: 52,
    waveCycles: 1,
    undulAmp: 80,
    spatialFreq: 0.85,
    vertCycles: 1,
    vertAmp: 0.042,
    phase: 0,
  },
  {
    id: "violet",
    centerY: 0.44,
    bandH: 258,
    color: "139, 92, 246",   // violet      #8b5cf6
    fill: 0.15,
    blur: 64,
    waveCycles: 2,
    undulAmp: 100,
    spatialFreq: 0.70,
    vertCycles: 1,
    vertAmp: 0.052,
    phase: TAU / 3,
  },
  {
    id: "indigo",
    centerY: 0.30,
    bandH: 180,
    color: "99, 102, 241",   // indigo      #6366f1
    fill: 0.18,
    blur: 42,
    waveCycles: 3,
    undulAmp: 60,
    spatialFreq: 1.10,
    vertCycles: 2,
    vertAmp: 0.032,
    phase: (TAU * 2) / 3,
  },
  {
    id: "teal",
    centerY: 0.50,
    bandH: 160,
    color: "6, 182, 212",    // teal        #06b6d4
    fill: 0.12,
    blur: 46,
    waveCycles: 2,
    undulAmp: 52,
    spatialFreq: 1.22,
    vertCycles: 1,
    vertAmp: 0.036,
    phase: Math.PI,
  },
]

// ── Light streak definitions ──────────────────────────────────────────────────
// Each streak has an `offset` (frames) that shifts its birth point within the loop.
// phaseTime = (frame + offset) % TOTAL_FRAMES  →  same at frame 0 and frame 600.
// `dur` frames: how long the streak traverses the canvas before disappearing.

type Streak = {
  offset: number   // frame offset to stagger streak births across the loop
  startX: number   // starting X (may be off-screen left/top/bottom)
  startY: number
  endX: number     // ending X (may be off-screen right)
  endY: number
  dur: number      // frames to cross the canvas — must be < TOTAL_FRAMES
  color: string    // "r, g, b" — comet-tail body color
  tailLen: number  // tail as fraction of total progress (head leads, tail lags)
}

const STREAKS: Streak[] = [
  { offset: 0,   startX: -350, startY: 175, endX: W + 290, endY: 318, dur: 88,  color: "147, 197, 253", tailLen: 0.38 },
  { offset: 94,  startX: -255, startY: 482, endX: W + 195, endY: 275, dur: 79,  color: "167, 139, 250", tailLen: 0.42 },
  { offset: 193, startX: -418, startY:  86, endX: W + 104, endY: 415, dur: 101, color: "103, 169, 240", tailLen: 0.32 },
  { offset: 263, startX:  -98, startY: 574, endX: W + 382, endY: 228, dur: 83,  color: "196, 181, 253", tailLen: 0.40 },
  { offset: 374, startX: -298, startY: 327, endX: W + 316, endY: 592, dur: 93,  color: "147, 197, 253", tailLen: 0.36 },
  { offset: 454, startX: -224, startY: 138, endX: W + 178, endY: 426, dur: 77,  color: "167, 139, 250", tailLen: 0.44 },
  { offset: 527, startX: -382, startY: 694, endX: W + 278, endY: 186, dur: 73,  color: "6, 182, 212",   tailLen: 0.33 },
]

// ── Stars (36 twinkling dots, deterministic LCG placement) ───────────────────
// Positions use prime-step LCG so coverage is uniform without Math.random().
// twinkleCycles is always a positive integer → sin completes exact cycles per loop.
// phase uses the golden angle for an even spread across [0, TAU).
const STARS = Array.from({ length: 36 }, (_, i) => ({
  id: i,
  x: (i * 1619 + 113) % W,
  y: Math.round(H * 0.07 + ((i * 2711 + 97) % Math.round(H * 0.86))),
  r: 0.55 + ((i * 1277 + 43) % 14) * 0.10,
  twinkleCycles: 1 + ((i * 7 + 3) % 6),
  phase: (i * 1.61803398875 * TAU) % TAU,
  baseAlpha: 0.22 + ((i * 431 + 17) % 10) * 0.045,
}))

// ── Micro-grain (premium noise texture) ──────────────────────────────────────
// 190 sub-pixel dots scattered via coprime strides for full-coverage distribution.
const GRAIN = Array.from({ length: 190 }, (_, i) => ({
  id: i,
  x: (i * 1277 + 31) % W,
  y: (i * 743  + 89) % H,
  r: 0.3 + (i % 4) * 0.2,
}))

// ── Aurora path builder ───────────────────────────────────────────────────────
// Returns a closed SVG `d` string for one aurora band at the given loop angle `t`.
// Cubic Bézier curves with purely horizontal control-point tangents produce a smooth
// organic wave.  The band extends from x = -220 to x = W+220 so the scrolling wave
// pattern never clips at the left/right edges.
const NUM_WAVE_PTS = 10

function buildAuroraPath(band: AuroraBand, t: number): string {
  // Horizontal wave phase: scrolls `waveCycles` full times per loop
  const wavePhase = t * band.waveCycles + band.phase

  // Vertical centre: drifts `vertCycles` full times per loop
  const cy =
    (band.centerY + Math.sin(t * band.vertCycles + band.phase) * band.vertAmp) * H

  const halfH = band.bandH / 2
  const xStart = -220
  const xEnd = W + 220
  const segW = (xEnd - xStart) / (NUM_WAVE_PTS - 1)
  const cp = segW / 3 // horizontal Bézier control offset → ensures smooth wave

  // Sample top & bottom edges along the band
  const topPts = Array.from({ length: NUM_WAVE_PTS }, (_, i) => {
    const u = i / (NUM_WAVE_PTS - 1)
    return {
      x: xStart + i * segW,
      y: cy - halfH + Math.sin(wavePhase + u * TAU * band.spatialFreq) * band.undulAmp,
    }
  })

  const botPts = Array.from({ length: NUM_WAVE_PTS }, (_, i) => {
    const u = i / (NUM_WAVE_PTS - 1)
    return {
      x: xStart + i * segW,
      // Offset phase (+1.9) and reduced amplitude for organic asymmetry
      y: cy + halfH + Math.sin(wavePhase + u * TAU * band.spatialFreq + 1.9) * band.undulAmp * 0.72,
    }
  })

  // Top edge — left to right, horizontal Bézier tangents
  let d = `M ${topPts[0].x.toFixed(1)},${topPts[0].y.toFixed(1)}`
  for (let i = 1; i < NUM_WAVE_PTS; i++) {
    const p0 = topPts[i - 1]
    const p1 = topPts[i]
    d += ` C ${(p0.x + cp).toFixed(1)},${p0.y.toFixed(1)}`
    d += ` ${(p1.x - cp).toFixed(1)},${p1.y.toFixed(1)}`
    d += ` ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`
  }

  // Right cap then bottom edge — right to left
  d += ` L ${botPts[NUM_WAVE_PTS - 1].x.toFixed(1)},${botPts[NUM_WAVE_PTS - 1].y.toFixed(1)}`
  for (let i = NUM_WAVE_PTS - 2; i >= 0; i--) {
    const p0 = botPts[i + 1]
    const p1 = botPts[i]
    d += ` C ${(p0.x - cp).toFixed(1)},${p0.y.toFixed(1)}`
    d += ` ${(p1.x + cp).toFixed(1)},${p1.y.toFixed(1)}`
    d += ` ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`
  }

  d += " Z"
  return d
}

// ── Component ─────────────────────────────────────────────────────────────────
export const TestimonialsBackground: React.FC = () => {
  const frame = useCurrentFrame()

  // Loop angle 0 → 2π over TOTAL_FRAMES; frame 0 == frame 600 for all trig.
  const t = (frame / TOTAL_FRAMES) * TAU

  // Central glow — 1 complete breath cycle per loop
  const centralPulse = Math.sin(t + Math.PI / 4)
  const centralOpacity = 0.066 + centralPulse * 0.026

  return (
    <AbsoluteFill style={{ backgroundColor: "hsl(0 0% 3.9%)" }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        style={{ position: "absolute", inset: 0 }}
        aria-hidden="true"
      >
        <defs>
          {/* ── Per-aurora-band blur filters ──────────────────────────────── */}
          {/* Generous y-range (±60%) ensures blur never clips the band edges */}
          {AURORA_BANDS.map((band) => (
            <filter
              key={`fdef-aurora-${band.id}`}
              id={`f-aurora-${band.id}`}
              x="-5%"
              y="-60%"
              width="110%"
              height="220%"
            >
              <feGaussianBlur stdDeviation={band.blur} />
            </filter>
          ))}

          {/* ── Composite streak filter ────────────────────────────────────── */}
          {/* Two-pass: a tight core + a wide bloom merged for a premium glow  */}
          <filter id="f-streak" x="-5%" y="-150%" width="110%" height="400%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4"  result="tight" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="bloom" />
            <feMerge>
              <feMergeNode in="bloom" />
              <feMergeNode in="tight" />
            </feMerge>
          </filter>

          {/* ── Central horizontal glow filter ─────────────────────────────── */}
          <filter id="f-central" x="-5%" y="-120%" width="110%" height="340%">
            <feGaussianBlur stdDeviation="28" />
          </filter>

          {/* ── Star soft-glow filter ─────────────────────────────────────── */}
          <filter id="f-star" x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>

          {/* ── Per-streak linear gradients ────────────────────────────────── */}
          {/* gradientUnits="userSpaceOnUse" so x1/y1 = tail, x2/y2 = head.    */}
          {/* Returns null when streak is off-screen; the matching <line> below */}
          {/* uses the identical guard so url(#sg-N) is never dangling.         */}
          {STREAKS.map((streak) => {
            const phaseTime = (frame + streak.offset) % TOTAL_FRAMES
            const progress = phaseTime / streak.dur
            if (progress <= 0.015 || progress >= 1) return null

            const dx = streak.endX - streak.startX
            const dy = streak.endY - streak.startY
            const headX = streak.startX + dx * progress
            const headY = streak.startY + dy * progress
            const tailProg = Math.max(0, progress - streak.tailLen)
            const tailX = streak.startX + dx * tailProg
            const tailY = streak.startY + dy * tailProg

            return (
              <linearGradient
                key={`sgdef-${streak.offset}`}
                id={`sg-${streak.offset}`}
                gradientUnits="userSpaceOnUse"
                x1={tailX.toFixed(1)}
                y1={tailY.toFixed(1)}
                x2={headX.toFixed(1)}
                y2={headY.toFixed(1)}
              >
                <stop offset="0%"   stopColor={`rgb(${streak.color})`} stopOpacity={0}    />
                <stop offset="62%"  stopColor={`rgb(${streak.color})`} stopOpacity={0.48} />
                <stop offset="100%" stopColor="rgb(255, 255, 255)"      stopOpacity={0.94} />
              </linearGradient>
            )
          })}
        </defs>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* AURORA BANDS                                                        */}
        {/* Four blurred bezier bands undulating across the mid-section.       */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        {AURORA_BANDS.map((band) => (
          <path
            key={`aurora-${band.id}`}
            d={buildAuroraPath(band, t)}
            fill={`rgba(${band.color}, ${band.fill})`}
            filter={`url(#f-aurora-${band.id})`}
          />
        ))}

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* CENTRAL HORIZONTAL GLOW                                            */}
        {/* Sits at 40 % height — exactly where the testimonial card row sits. */}
        {/* Pulsing once per loop keeps it alive without being distracting.    */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <ellipse
          cx={W / 2}
          cy={H * 0.40}
          rx={W * 0.67}
          ry={68}
          fill={`rgba(99, 102, 241, ${centralOpacity.toFixed(4)})`}
          filter="url(#f-central)"
        />

        {/* A secondary, wider indigo haze layer below the cards */}
        <ellipse
          cx={W * 0.52}
          cy={H * 0.48}
          rx={W * 0.42}
          ry={44}
          fill={`rgba(139, 92, 246, ${(0.042 + centralPulse * 0.016).toFixed(4)})`}
          filter="url(#f-central)"
        />

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* LIGHT STREAKS                                                       */}
        {/* Diagonal comet-tails that sweep across the composition.            */}
        {/* Gradient direction follows the streak vector (tail → head).        */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        {STREAKS.map((streak) => {
          const phaseTime = (frame + streak.offset) % TOTAL_FRAMES
          const progress = phaseTime / streak.dur
          if (progress <= 0.015 || progress >= 1) return null

          const dx = streak.endX - streak.startX
          const dy = streak.endY - streak.startY
          const headX = streak.startX + dx * progress
          const headY = streak.startY + dy * progress
          const tailProg = Math.max(0, progress - streak.tailLen)
          const tailX = streak.startX + dx * tailProg
          const tailY = streak.startY + dy * tailProg

          const fadeOpacity = interpolate(
            progress,
            [0.015, 0.13, 0.80, 1.0],
            [0, 1, 1, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )

          return (
            <line
              key={`streak-${streak.offset}`}
              x1={tailX.toFixed(1)}
              y1={tailY.toFixed(1)}
              x2={headX.toFixed(1)}
              y2={headY.toFixed(1)}
              stroke={`url(#sg-${streak.offset})`}
              strokeWidth={1.8}
              strokeLinecap="round"
              opacity={fadeOpacity.toFixed(4)}
              filter="url(#f-streak)"
            />
          )
        })}

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* TWINKLING STARS                                                     */}
        {/* Each star uses an integer twinkleCycles so it is perfectly in sync  */}
        {/* at frame 0 and frame TOTAL_FRAMES.                                  */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        <g filter="url(#f-star)">
          {STARS.map((star) => {
            const twinkle = 0.5 + 0.5 * Math.sin(t * star.twinkleCycles + star.phase)
            const alpha = star.baseAlpha * (0.25 + twinkle * 0.75)
            return (
              <circle
                key={`star-${star.id}`}
                cx={star.x}
                cy={star.y}
                r={star.r}
                fill={`rgba(255, 255, 255, ${alpha.toFixed(3)})`}
              />
            )
          })}
        </g>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* MICRO-GRAIN TEXTURE                                                 */}
        {/* Static sub-pixel dots add subtle premium depth.                    */}
        {/* ═══════════════════════════════════════════════════════════════════ */}
        {GRAIN.map((dot) => (
          <circle
            key={`gr-${dot.id}`}
            cx={dot.x}
            cy={dot.y}
            r={dot.r}
            fill="rgba(255, 255, 255, 0.018)"
          />
        ))}
      </svg>

      {/* ── Edge gradient fades — blend seamlessly with page background ─────── */}
      {/* Top */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 145,
          background:
            "linear-gradient(to bottom, hsl(0 0% 3.9%) 0%, transparent 100%)",
        }}
      />

      {/* Bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 215,
          background:
            "linear-gradient(to top, hsl(0 0% 3.9%) 0%, transparent 100%)",
        }}
      />
    </AbsoluteFill>
  )
}

export default TestimonialsBackground
