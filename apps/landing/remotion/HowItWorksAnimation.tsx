import React from "react"
import { AbsoluteFill, useCurrentFrame, interpolate, spring } from "remotion"

// ─── Canvas ────────────────────────────────────────────────────────────────
const W = 1920
const H = 1080
const FPS = 30

const C = {
  boardBg: "#0a0a0a",
  bgSecondary: "#111111",
  bgTertiary: "#1a1a1a",
  cardBg: "rgba(255,255,255,0.04)",
  cardBorder: "rgba(255,255,255,0.10)",
  dialogBg: "#161616",
  dialogBorder: "#333333",
  colDivider: "rgba(255,255,255,0.08)",
  colHeaderBg: "rgba(255,255,255,0.03)",
  colBorderB: "rgba(255,255,255,0.06)",
  textPrimary: "#ffffff",
  textSecondary: "#b4b4b4",
  textTertiary: "#737373",
  placeholder: "#525252",
  colHeader: "#888888",
  blue: "#5b8aff",
  green: "#4ade80",
  amber: "#fbbf24",
  purple: "#c084fc",
  statusTodo: "#9ca3af",
  statusInProgress: "#fbbf24",
  statusDone: "#4ade80",
  border: "#262626",
  borderHover: "#404040",
}

const TASK1_TITLE = "more details in the get started section"
const TASK2_TITLE = "create a new model provider doc"
const TASK3_TITLE = "remove ai slop from the docs"
const TASK1_ID = "KT-4"
const TASK2_ID = "KT-3"
const TASK3_ID = "KT-2"

const PRE_EXISTING_TASKS = [
  { title: "fix authentication bug", id: "KT-1" },
  { title: "update readme with new api", id: "KT-5" },
  { title: "add dark mode toggle", id: "KT-6" },
  { title: "optimize bundle size", id: "KT-7" },
  { title: "add unit tests", id: "KT-8" },
]

// ─── Layout constants ───────────────────────────────────────────────────────
const SB_W = 240
const CONTENT_X = SB_W
const CONTENT_W = W - SB_W
const TOPBAR_H = 56
const CFG_H = 36
const COL_COUNT = 4
const COL_W = Math.floor(CONTENT_W / COL_COUNT)
const COL_Y = TOPBAR_H + CFG_H
const COL_H = H - COL_Y
const COL_HEADER_H = 44

const CARD_W = COL_W - 24
const CARD_H = 88
const CARD_H_WITH_PROGRESS = 118

const COL_0 = CONTENT_X
const COL_1 = CONTENT_X + COL_W
const COL_2 = CONTENT_X + COL_W * 2
const COL_3 = CONTENT_X + COL_W * 3
const CP = 12 // Card padding from column edge
const CY0 = COL_Y + COL_HEADER_H + 12 // First card Y

const DLG_W = 520
const DLG_H = 280
const DLG_X = (W - DLG_W) / 2
const DLG_Y = (H - DLG_H) / 2

// Batch controls
const BATCH_W = 520
const BATCH_H = 52
const BATCH_X = (W - BATCH_W) / 2
const BATCH_Y = H - 72

function ramp(frame: number, a: number, b: number) {
  return interpolate(frame, [a, b], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  })
}

function easeOut(frame: number, a: number, b: number) {
  const t = ramp(frame, a, b)
  return 1 - (1 - t) * (1 - t)
}

// ─── Icons ──────────────────────────────────────────────────────────────────
function HomeIcon({ x, y, size = 16 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <path d={`M${size/2} 2 L${size-2} ${size/2} V${size-2} H2 V${size/2} Z`} 
        fill="none" stroke="currentColor" strokeWidth="1.5" />
    </g>
  )
}

function InboxIcon({ x, y, size = 16 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <rect x="2" y="4" width={size-4} height={size-6} rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d={`M2 ${size/2+2} L${size/2} ${size-2} L${size-2} ${size/2+2}`} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </g>
  )
}

function LayersIcon({ x, y, size = 16 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <polygon points={`${size/2},2 ${size-2},6 ${size/2},10 2,6`} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <polygon points={`${size/2},6 ${size-2},10 ${size/2},14 2,10`} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </g>
  )
}

function SettingsIcon({ x, y, size = 16 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <circle cx={size/2} cy={size/2} r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d={`M${size/2} 1 V3 M${size/2} ${size-3} V${size-1} M1 ${size/2} H3 M${size-3} ${size/2} H${size-1}`} 
        stroke="currentColor" strokeWidth="1.5" />
    </g>
  )
}

function GitBranchIcon({ x, y, size = 14 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <circle cx="3" cy="3" r="1.5" fill="currentColor" />
      <circle cx="3" cy={size-3} r="1.5" fill="currentColor" />
      <circle cx={size-3} cy={size-3} r="1.5" fill="currentColor" />
      <path d={`M3 4.5 V${size-4.5} M4.5 ${size-3} H${size-4.5}`} stroke="currentColor" strokeWidth="1.5" />
    </g>
  )
}

function CircleDotIcon({ x, y, size = 14 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <circle cx={size/2} cy={size/2} r={size/2 - 1} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx={size/2} cy={size/2} r="2" fill="currentColor" />
    </g>
  )
}

function PlayIcon({ x, y, size = 14 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <polygon points={`${size/4},${size/4} ${size/4},${size*0.75} ${size*0.75},${size/2}`} fill="currentColor" />
    </g>
  )
}

function CheckIcon({ x, y, size = 16 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <path d={`M3 ${size/2} L${size/3} ${size-3} L${size-2} 3`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}

function ListOrderedIcon({ x, y, size = 14 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <text x="2" y="5" fill="currentColor" fontSize="7" fontFamily="system-ui">1</text>
      <text x="2" y="11" fill="currentColor" fontSize="7" fontFamily="system-ui">2</text>
      <line x1="8" y1="3" x2={size-2} y2="3" stroke="currentColor" strokeWidth="1.5" />
      <line x1="8" y1="9" x2={size-2} y2="9" stroke="currentColor" strokeWidth="1.5" />
    </g>
  )
}

function XIcon({ x, y, size = 14 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <line x1="3" y1="3" x2={size-3} y2={size-3} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line x1={size-3} y1="3" x2="3" y2={size-3} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </g>
  )
}

function GitPullRequestIcon({ x, y, size = 14 }: { x: number; y: number; size?: number }) {
  return (
    <g transform={`translate(${x - size/2},${y - size/2})`}>
      <circle cx="3" cy="3" r="1.5" fill="currentColor" />
      <circle cx="3" cy={size-3} r="1.5" fill="currentColor" />
      <circle cx={size-3} cy={size-3} r="1.5" fill="currentColor" />
      <path d={`M3 4.5 V${size-4.5}`} stroke="currentColor" strokeWidth="1.5" />
      <path d={`M${size-3} ${size-4.5} V${size/2} Q${size-3} ${size/2-2} ${size-5} ${size/2-2} H${size/2}`} 
        stroke="currentColor" strokeWidth="1.5" fill="none" />
    </g>
  )
}

// ─── Components ─────────────────────────────────────────────────────────────
function Sidebar({ opacity }: { opacity: number }) {
  const teamColor = "#8b5cf6"
  
  return (
    <g opacity={opacity}>
      <rect x={0} y={0} width={SB_W} height={H} fill={C.bgSecondary} />
      <line x1={SB_W} y1={0} x2={SB_W} y2={H} stroke={C.colDivider} strokeWidth={1} />
      
      {/* Logo area */}
      <rect x={0} y={0} width={SB_W} height={TOPBAR_H} fill="rgba(255,255,255,0.01)" />
      <line x1={0} y1={TOPBAR_H} x2={SB_W} y2={TOPBAR_H} stroke={C.colDivider} strokeWidth={1} />
      <circle cx={20} cy={TOPBAR_H/2} r={8} fill={C.blue} />
      <text x={36} y={TOPBAR_H/2 + 5} fill={C.textPrimary} fontSize={13} fontWeight={600} fontFamily="system-ui,-apple-system,sans-serif">
        OpenLinear
      </text>
      
      {/* Nav items */}
      <g transform={`translate(0, ${TOPBAR_H + 12})`}>
        {/* Home */}
        <rect x={8} y={0} width={SB_W - 16} height={32} rx={6} fill="transparent" />
        <HomeIcon x={24} y={16} size={16} />
        <text x={44} y={20} fill={C.textSecondary} fontSize={13} fontFamily="system-ui,-apple-system,sans-serif">Home</text>
        
        {/* My Issues - Active */}
        <rect x={8} y={36} width={SB_W - 16} height={32} rx={6} fill="rgba(255,255,255,0.05)" />
        <LayersIcon x={24} y={52} size={16} />
        <text x={44} y={56} fill={C.textPrimary} fontSize={13} fontWeight={500} fontFamily="system-ui,-apple-system,sans-serif">My Issues</text>
        
        {/* Inbox */}
        <rect x={8} y={72} width={SB_W - 16} height={32} rx={6} fill="transparent" />
        <InboxIcon x={24} y={88} size={16} />
        <text x={44} y={92} fill={C.textSecondary} fontSize={13} fontFamily="system-ui,-apple-system,sans-serif">Inbox</text>
        
        {/* Your Teams section */}
        <text x={16} y={136} fill={C.textTertiary} fontSize={11} fontWeight={600} letterSpacing={0.5} fontFamily="system-ui,-apple-system,sans-serif">
          YOUR TEAMS
        </text>
        
        {/* Team: kaizen403's Team */}
        <g transform="translate(8, 148)">
          <rect width={SB_W - 16} height={32} rx={6} fill="transparent" />
          <rect x={16} y={8} width={16} height={16} rx={4} fill={`${teamColor}25`} />
          <text x={24} y={20} textAnchor="middle" fill={teamColor} fontSize={10} fontWeight={700} fontFamily="system-ui,-apple-system,sans-serif">K</text>
          <text x={40} y={20} fill={C.textSecondary} fontSize={13} fontFamily="system-ui,-apple-system,sans-serif">kaizen403's Team</text>
        </g>
        
        {/* Team sub-items */}
        <g transform="translate(24, 184)">
          <rect width={SB_W - 40} height={28} rx={6} fill="rgba(255,255,255,0.05)" />
          <CircleDotIcon x={16} y={14} size={14} />
          <text x={36} y={18} fill={C.textPrimary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">Issues</text>
          
          <g transform="translate(0, 30)">
            <rect width={SB_W - 40} height={28} rx={6} fill="transparent" />
            <GitBranchIcon x={16} y={14} size={14} />
            <text x={36} y={18} fill={C.textSecondary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">Projects</text>
          </g>
          
          <g transform="translate(0, 60)">
            <rect width={SB_W - 40} height={28} rx={6} fill="transparent" />
            <SettingsIcon x={16} y={14} size={14} />
            <text x={36} y={18} fill={C.textSecondary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">Manage</text>
          </g>
        </g>
        
        {/* Settings at bottom */}
        <g transform={`translate(8, ${H - 160})`}>
          <rect width={SB_W - 16} height={32} rx={6} fill="transparent" />
          <SettingsIcon x={16} y={16} size={16} />
          <text x={40} y={20} fill={C.textSecondary} fontSize={13} fontFamily="system-ui,-apple-system,sans-serif">Settings</text>
        </g>
      </g>
    </g>
  )
}

function TopBar({ opacity }: { opacity: number }) {
  return (
    <g opacity={opacity}>
      <rect x={CONTENT_X} y={0} width={CONTENT_W} height={TOPBAR_H} fill={C.boardBg} />
      <line x1={CONTENT_X} y1={TOPBAR_H} x2={W} y2={TOPBAR_H} stroke={C.colDivider} strokeWidth={1} />
      <text x={CONTENT_X + 16} y={TOPBAR_H / 2 + 5} fill={C.textPrimary} fontSize={15} fontWeight={600} fontFamily="system-ui,-apple-system,sans-serif">
        docs
      </text>
    </g>
  )
}

function ConfigStrip({ 
  opacity, 
  workflowValue = "Idle",
  selectionValue = "None"
}: { 
  opacity: number
  workflowValue?: string
  selectionValue?: string
}) {
  const items = [
    { icon: "git-branch", label: "SOURCE", value: "kaizen403/docs" },
    { icon: "git-branch", label: "BRANCH", value: "main" },
    { icon: "circle-dot", label: "SCOPE", value: "3 issues" },
    { icon: "play", label: "WORKFLOW", value: workflowValue },
    { icon: "layers", label: "SELECTION", value: selectionValue },
  ]
  const itemW = 220
  
  return (
    <g opacity={opacity}>
      <rect x={CONTENT_X} y={TOPBAR_H} width={CONTENT_W} height={CFG_H} fill="rgba(255,255,255,0.01)" />
      <line x1={CONTENT_X} y1={TOPBAR_H + CFG_H} x2={W} y2={TOPBAR_H + CFG_H} stroke={C.colDivider} strokeWidth={1} />
      
      {items.map((item, i) => {
        const ix = CONTENT_X + i * itemW
        return (
          <g key={item.label}>
            {i > 0 && (
              <line x1={ix} y1={TOPBAR_H} x2={ix} y2={TOPBAR_H + CFG_H} stroke={C.colDivider} strokeWidth={1} />
            )}
            <text x={ix + 12} y={TOPBAR_H + 12} fill={C.textTertiary} fontSize={8} letterSpacing={1.2} fontFamily="system-ui,-apple-system,sans-serif">
              {item.label}
            </text>
            <text x={ix + 12} y={TOPBAR_H + 26} fill={C.textSecondary} fontSize={10} fontWeight={500} fontFamily="system-ui,-apple-system,sans-serif">
              {item.value}
            </text>
          </g>
        )
      })}
      
      {/* Model selector */}
      <g transform={`translate(${CONTENT_X + items.length * itemW + 20}, ${TOPBAR_H + 8})`}>
        <rect x={0} y={0} width={180} height={20} rx={4} fill={C.bgTertiary} stroke={C.border} strokeWidth={1} />
        <text x={8} y={14} fill={C.textSecondary} fontSize={10} fontFamily="system-ui,-apple-system,sans-serif">
          Claude Opus 4.6
        </text>
        <text x={160} y={14} fill={C.textTertiary} fontSize={8} fontFamily="system-ui,-apple-system,sans-serif">▼</text>
      </g>
    </g>
  )
}

function ColHeader({ 
  x, 
  title, 
  count, 
  plusHighlight = 0,
  selectHighlight = 0,
  showSelect = false
}: { 
  x: number; 
  title: string; 
  count: number; 
  plusHighlight?: number;
  selectHighlight?: number;
  showSelect?: boolean;
}) {
  const plusX = x + COL_W - 28
  const selectX = showSelect ? x + COL_W - 90 : plusX

  return (
    <g>
      <rect x={x} y={COL_Y} width={COL_W} height={COL_HEADER_H} fill={C.colHeaderBg} />
      <line x1={x} y1={COL_Y + COL_HEADER_H} x2={x + COL_W} y2={COL_Y + COL_HEADER_H} stroke={C.colBorderB} strokeWidth={1} />
      <text x={x + 14} y={COL_Y + 26} fill={C.colHeader} fontSize={10} fontWeight={500} letterSpacing={1.4} fontFamily="system-ui,-apple-system,sans-serif">
        {title.toUpperCase()}
      </text>
      <rect x={x + 14 + title.length * 6.5 + 8} y={COL_Y + 14} width={24} height={16} rx={4}
        fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.08)" strokeWidth={1} />
      <text x={x + 14 + title.length * 6.5 + 20} y={COL_Y + 25} fill={C.colHeader} fontSize={10} fontWeight={500} textAnchor="middle" fontFamily="system-ui,-apple-system,sans-serif">
        {count}
      </text>
      
      {/* Select button */}
      {showSelect && (
        <g>
          <rect x={selectX} y={COL_Y + 10} width={54} height={24} rx={4}
            fill={selectHighlight > 0.01 ? `rgba(59,130,246,${0.15 + selectHighlight * 0.2})` : C.bgTertiary}
            stroke={selectHighlight > 0.01 ? `rgba(59,130,246,${0.4 + selectHighlight * 0.3})` : C.border}
            strokeWidth={1} />
          <text x={selectX + 27} y={COL_Y + 25} textAnchor="middle" 
            fill={selectHighlight > 0.01 ? C.textPrimary : C.textSecondary}
            fontSize={9} fontWeight={500} letterSpacing={0.5} fontFamily="system-ui,-apple-system,sans-serif">
            SELECT
          </text>
        </g>
      )}
      
      {/* Plus button */}
      <rect x={plusX - 11} y={COL_Y + 10} width={24} height={24} rx={4}
        fill={plusHighlight > 0.01 ? `rgba(255,255,255,${0.08 + plusHighlight * 0.12})` : "transparent"} />
      <text x={plusX} y={COL_Y + 27} textAnchor="middle"
        fill={plusHighlight > 0.01 ? `rgba(255,255,255,${0.7 + plusHighlight * 0.3})` : C.textTertiary}
        fontSize={16} fontFamily="system-ui,-apple-system,sans-serif">
        +
      </text>
    </g>
  )
}

function EmptyState({ x }: { x: number }) {
  const cx = x + COL_W / 2
  const cy = COL_Y + COL_HEADER_H + 80

  return (
    <g>
      <circle cx={cx} cy={cy} r={22} fill="rgba(255,255,255,0.04)" />
      <text x={cx} y={cy + 7} textAnchor="middle" fill={C.textTertiary} fontSize={18} fontFamily="system-ui,-apple-system,sans-serif">+</text>
      <text x={cx} y={cy + 36} textAnchor="middle" fill={C.textTertiary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">Add task</text>
    </g>
  )
}

type ProgressState = "cloning" | "executing" | "committing" | "creating_pr" | "done" | null

function TaskCard({
  x, y, opacity = 1, title, identifier,
  showCheckbox = false, checked = false,
  progressState = null, isDone = false,
}: {
  x: number; y: number; opacity?: number
  title: string; identifier: string
  showCheckbox?: boolean; checked?: boolean
  progressState?: ProgressState; isDone?: boolean
}) {
  const progMap = {
    cloning: { text: "Cloning...", color: "#60a5fa" },
    executing: { text: "Executing...", color: C.blue },
    committing: { text: "Committing...", color: C.amber },
    creating_pr: { text: "Creating PR...", color: C.purple },
    done: { text: "Done ✓", color: C.green },
  }
  const prog = progressState ? progMap[progressState] : null
  const hasExtra = prog || isDone
  const cardH = hasExtra ? CARD_H_WITH_PROGRESS : CARD_H

  return (
    <g opacity={opacity}>
      {/* Shadow */}
      <rect x={x + 3} y={y + 4} width={CARD_W} height={cardH} rx={12} fill="rgba(0,0,0,0.5)" />
      
      {/* Card bg */}
      <rect x={x} y={y} width={CARD_W} height={cardH} rx={12}
        fill={isDone ? "rgba(74,222,128,0.08)" : C.cardBg}
        stroke={isDone ? "rgba(74,222,128,0.20)" : C.cardBorder}
        strokeWidth={1} />
      
      {/* Top highlight */}
      <rect x={x + 1} y={y + 1} width={CARD_W - 2} height={1} rx={0.5} fill="rgba(255,255,255,0.06)" />
      
      {/* Checkbox */}
      {showCheckbox && (
        <g transform={`translate(${x + 12}, ${y + 16})`}>
          <rect x={0} y={0} width={16} height={16} rx={4}
            fill={checked ? C.blue : C.bgSecondary}
            stroke={checked ? C.blue : C.border}
            strokeWidth={1} />
          {checked && (
            <CheckIcon x={8} y={8} size={10} />
          )}
        </g>
      )}
      
      {/* Title */}
      <text x={showCheckbox ? x + 36 : x + 14} y={y + 28} 
        fill={C.textPrimary} fontSize={13} fontWeight={400} fontFamily="system-ui,-apple-system,sans-serif">
        {title.length > 36 ? title.slice(0, 36) + "…" : title}
      </text>
      
      {/* Progress or View PR */}
      {prog && (
        <g transform={`translate(${x + 12}, ${y + 48})`}>
          <rect x={0} y={0} width={CARD_W - 24} height={26} rx={4} fill="rgba(255,255,255,0.03)" />
          <circle cx={12} cy={13} r={5} fill="none" stroke={prog.color} strokeWidth={1.5} strokeDasharray="8 4" />
          <text x={26} y={17} fill={C.textSecondary} fontSize={11} fontFamily="system-ui,-apple-system,sans-serif">
            {prog.text}
          </text>
        </g>
      )}
      
      {isDone && !prog && (
        <g transform={`translate(${x + 12}, ${y + 52})`}>
          <GitPullRequestIcon x={8} y={8} size={12} />
          <text x={24} y={12} fill={C.blue} fontSize={11} fontFamily="system-ui,-apple-system,sans-serif">
            View PR
          </text>
        </g>
      )}
      
      {/* Identifier */}
      <text x={x + 14} y={y + cardH - 10} fill={C.textTertiary} fontSize={10} fontFamily="ui-monospace,SFMono-Regular,monospace">
        {identifier}
      </text>
      
      {/* Spinner or checkmark */}
      {(prog || isDone) && (
        <g transform={`translate(${x + CARD_W - 28}, ${y + 16})`}>
          {prog ? (
            <circle cx={8} cy={8} r={6} fill="none" stroke={C.blue} strokeWidth={1.5} strokeDasharray="12 6" />
          ) : (
            <CheckIcon x={8} y={8} size={14} />
          )}
        </g>
      )}
    </g>
  )
}

function StaticCard({
  x, y, title, identifier
}: {
  x: number; y: number; title: string; identifier: string
}) {
  return (
    <g>
      <rect x={x + 3} y={y + 4} width={CARD_W} height={CARD_H} rx={12} fill="rgba(0,0,0,0.5)" />
      <rect x={x} y={y} width={CARD_W} height={CARD_H} rx={12}
        fill={C.cardBg}
        stroke={C.cardBorder}
        strokeWidth={1} />
      <rect x={x + 1} y={y + 1} width={CARD_W - 2} height={1} rx={0.5} fill="rgba(255,255,255,0.06)" />
      <text x={x + 14} y={y + 28} 
        fill={C.textPrimary} fontSize={13} fontWeight={400} fontFamily="system-ui,-apple-system,sans-serif">
        {title.length > 36 ? title.slice(0, 36) + "…" : title}
      </text>
      <text x={x + 14} y={y + CARD_H - 10} fill={C.textTertiary} fontSize={10} fontFamily="ui-monospace,SFMono-Regular,monospace">
        {identifier}
      </text>
    </g>
  )
}

function TaskFormDialog({ 
  scale, opacity, title, titleChars, buttonPulse = 0 
}: { 
  scale: number; opacity: number; title: string; titleChars: number; buttonPulse?: number 
}) {
  const titleText = title.slice(0, titleChars)
  const showCursor = titleChars < title.length && titleChars > 0
  const cx = DLG_X + DLG_W / 2
  const cy = DLG_Y + DLG_H / 2

  return (
    <g transform={`translate(${cx},${cy}) scale(${scale}) translate(${-cx},${-cy})`} opacity={opacity}>
      <rect x={DLG_X + 8} y={DLG_Y + 10} width={DLG_W} height={DLG_H} rx={16} fill="rgba(0,0,0,0.6)" filter="url(#dlg-shadow)" />
      
      <rect x={DLG_X} y={DLG_Y} width={DLG_W} height={DLG_H} rx={16}
        fill={C.dialogBg} stroke={C.dialogBorder} strokeWidth={1} />
      
      <rect x={DLG_X + 1} y={DLG_Y + 1} width={DLG_W - 2} height={1} rx={0.5} fill="rgba(255,255,255,0.05)" />
      
      {/* Title input */}
      <text x={DLG_X + 20} y={DLG_Y + 40}
        fill={titleChars === 0 ? C.placeholder : C.textPrimary}
        fontSize={15} fontWeight={500} fontFamily="system-ui,-apple-system,sans-serif">
        {titleChars === 0 ? "Issue title" : titleText}
        {showCursor && <tspan fill={C.blue}>|</tspan>}
      </text>
      
      {/* Description placeholder */}
      <text x={DLG_X + 20} y={DLG_Y + 68} fill={C.placeholder} fontSize={13} fontFamily="system-ui,-apple-system,sans-serif">
        Add description...
      </text>
      
      {/* Divider */}
      <line x1={DLG_X} y1={DLG_Y + 90} x2={DLG_X + DLG_W} y2={DLG_Y + 90} stroke={C.dialogBorder} strokeWidth={1} />
      
      {/* Status selector */}
      <g transform={`translate(${DLG_X + 20}, ${DLG_Y + 110})`}>
        <circle cx={6} cy={6} r={4} fill={C.statusTodo} />
        <text x={18} y={10} fill={C.textSecondary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">Todo</text>
      </g>
      
      {/* Labels */}
      <text x={DLG_X + 100} y={DLG_Y + 120} fill={C.textSecondary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">Labels</text>
      
      {/* Due date */}
      <text x={DLG_X + 180} y={DLG_Y + 120} fill={C.textSecondary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">Due date</text>
      
      {/* Bottom divider */}
      <line x1={DLG_X} y1={DLG_Y + 210} x2={DLG_X + DLG_W} y2={DLG_Y + 210} stroke={C.dialogBorder} strokeWidth={1} />
      
      {/* Cancel button */}
      <text x={DLG_X + DLG_W - 180} y={DLG_Y + 250} textAnchor="middle" fill={C.textSecondary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">
        Cancel
      </text>
      
      {/* Create Task button */}
      <rect x={DLG_X + DLG_W - 130} y={DLG_Y + 232} width={110} height={32} rx={6}
        fill={`rgba(59,130,246,${0.9 + buttonPulse * 0.1})`}
        stroke={buttonPulse > 0.05 ? `rgba(59,130,246,0.8)` : "transparent"}
        strokeWidth={buttonPulse > 0.05 ? 2 : 0} />
      <text x={DLG_X + DLG_W - 75} y={DLG_Y + 252} textAnchor="middle" fill="#ffffff" 
        fontSize={12} fontWeight={500} fontFamily="system-ui,-apple-system,sans-serif">
        Create Task
      </text>
    </g>
  )
}

function ParallelIssuesGroup({
  x, y, opacity = 1,
  prHighlight = 0
}: {
  x: number; y: number; opacity?: number
  prHighlight?: number
}) {
  const groupW = CARD_W + 16
  const groupH = 220
  const gy = y - 8

  return (
    <g opacity={opacity}>
      {/* Container */}
      <rect x={x - 8} y={gy} width={groupW} height={groupH} rx={12}
        fill="rgba(168,85,247,0.03)"
        stroke={`rgba(168,85,247,${0.2 + prHighlight * 0.2})`}
        strokeWidth={1}
        strokeDasharray="4 2" />
      
      {/* Header */}
      <g transform={`translate(${x}, ${gy + 12})`}>
        {/* Grip handle */}
        <g transform="translate(0, 2)">
          <circle cx={3} cy={3} r={1.5} fill={C.textTertiary} />
          <circle cx={3} cy={9} r={1.5} fill={C.textTertiary} />
          <circle cx={9} cy={3} r={1.5} fill={C.textTertiary} />
          <circle cx={9} cy={9} r={1.5} fill={C.textTertiary} />
        </g>
        
        <text x={20} y={12} fill={C.purple} fontSize={10} fontWeight={600} letterSpacing={0.5} fontFamily="system-ui,-apple-system,sans-serif">
          PARALLEL ISSUES
        </text>
        
        {/* Open PR button */}
        <g transform={`translate(${CARD_W - 80}, -4)`}>
          <rect x={0} y={0} width={76} height={24} rx={6}
            fill={`rgba(168,85,247,${0.15 + prHighlight * 0.15})`}
            stroke={`rgba(168,85,247,${0.4 + prHighlight * 0.3})`}
            strokeWidth={1} />
          <GitPullRequestIcon x={12} y={12} size={12} />
          <text x={50} y={16} textAnchor="middle" fill={C.purple} fontSize={10} fontWeight={500} fontFamily="system-ui,-apple-system,sans-serif">
            Open PR
          </text>
        </g>
      </g>
      
      {/* Task 1 */}
      <g transform={`translate(${x}, ${gy + 44})`}>
        <rect x={0} y={0} width={CARD_W} height={82} rx={10}
          fill="rgba(34,197,94,0.04)"
          stroke="rgba(34,197,94,0.12)"
          strokeWidth={1} />
        <text x={12} y={26} fill={C.textPrimary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">
          {TASK1_TITLE.length > 34 ? TASK1_TITLE.slice(0, 34) + "…" : TASK1_TITLE}
        </text>
        <text x={12} y={68} fill={C.textTertiary} fontSize={10} fontFamily="ui-monospace,SFMono-Regular,monospace">
          {TASK1_ID}
        </text>
        <CheckIcon x={CARD_W - 24} y={20} size={14} />
      </g>
      
      {/* Task 2 */}
      <g transform={`translate(${x}, ${gy + 130})`}>
        <rect x={0} y={0} width={CARD_W} height={82} rx={10}
          fill="rgba(34,197,94,0.04)"
          stroke="rgba(34,197,94,0.12)"
          strokeWidth={1} />
        <text x={12} y={26} fill={C.textPrimary} fontSize={12} fontFamily="system-ui,-apple-system,sans-serif">
          {TASK2_TITLE.length > 34 ? TASK2_TITLE.slice(0, 34) + "…" : TASK2_TITLE}
        </text>
        <text x={12} y={68} fill={C.textTertiary} fontSize={10} fontFamily="ui-monospace,SFMono-Regular,monospace">
          {TASK2_ID}
        </text>
        <CheckIcon x={CARD_W - 24} y={20} size={14} />
      </g>
    </g>
  )
}

function BatchControls({
  opacity = 1,
  selectedCount = 2,
  executeParallelHighlight = 0
}: {
  opacity?: number
  selectedCount?: number
  executeParallelHighlight?: number
}) {
  return (
    <g opacity={opacity} transform={`translate(${BATCH_X}, ${BATCH_Y})`}>
      {/* Background */}
      <rect x={0} y={0} width={BATCH_W} height={BATCH_H} rx={12}
        fill={C.bgSecondary}
        stroke={C.border}
        strokeWidth={1} />
      
      {/* Selection text */}
      <text x={20} y={32} fill={C.textSecondary} fontSize={14} fontFamily="system-ui,-apple-system,sans-serif">
        {selectedCount} task{selectedCount !== 1 ? 's' : ''} selected
      </text>
      
      {/* Divider */}
      <line x1={145} y1={14} x2={145} y2={38} stroke={C.border} strokeWidth={1} />
      
      {/* Execute Parallel button */}
      <g transform="translate(160, 10)">
        <rect x={0} y={0} width={140} height={32} rx={6}
          fill={`rgba(59,130,246,${0.9 + executeParallelHighlight * 0.1})`}
          stroke={executeParallelHighlight > 0.05 ? `rgba(59,130,246,0.8)` : "transparent"}
          strokeWidth={executeParallelHighlight > 0.05 ? 2 : 0} />
        <PlayIcon x={16} y={16} size={14} />
        <text x={42} y={20} fill="#ffffff" fontSize={12} fontWeight={500} fontFamily="system-ui,-apple-system,sans-serif">
          Execute Parallel
        </text>
      </g>
      
      {/* Execute Queue button */}
      <g transform="translate(310, 10)">
        <rect x={0} y={0} width={130} height={32} rx={6}
          fill="transparent"
          stroke={C.border}
          strokeWidth={1} />
        <ListOrderedIcon x={14} y={16} size={14} />
        <text x={36} y={20} fill={C.textPrimary} fontSize={12} fontWeight={500} fontFamily="system-ui,-apple-system,sans-serif">
          Execute Queue
        </text>
      </g>
      
      {/* Close button */}
      <g transform="translate(460, 10)">
        <rect x={0} y={0} width={32} height={32} rx={6} fill="transparent" />
        <XIcon x={16} y={16} size={16} />
      </g>
    </g>
  )
}

function ArrowCursor({ x, y, opacity }: { x: number; y: number; opacity: number }) {
  return (
    <g opacity={opacity} transform={`translate(${x},${y})`}>
      <polygon points="0,0 0,18 4,14 8,20 11,18 7,12 14,12"
        fill="white" stroke="rgba(0,0,0,0.7)" strokeWidth={1.5} strokeLinejoin="round" />
    </g>
  )
}

function ColumnDividers() {
  return (
    <g>
      <line x1={COL_1} y1={COL_Y} x2={COL_1} y2={H} stroke={C.colDivider} strokeWidth={1} />
      <line x1={COL_2} y1={COL_Y} x2={COL_2} y2={H} stroke={C.colDivider} strokeWidth={1} />
      <line x1={COL_3} y1={COL_Y} x2={COL_3} y2={H} stroke={C.colDivider} strokeWidth={1} />
    </g>
  )
}

// ─── Main Animation ─────────────────────────────────────────────────────────
export const HowItWorksAnimation: React.FC = () => {
  const frame = useCurrentFrame()

  // Global fade
  const boardFadeIn = ramp(frame, 0, 30)
  const fadeOut = ramp(frame, 420, 450)
  const globalOpacity = Math.min(boardFadeIn, 1 - fadeOut)

  // Config strip values
  const workflowValue = frame < 260 ? "Idle" : frame < 340 ? "2 issues running" : "Idle"
  const selectionValue = frame < 220 ? "None" : frame < 260 ? "2 selected" : "None"

  // Column counts
  const allIssuesCount = frame < 115 ? 0 : frame < 260 ? (frame < 200 ? 1 : 2) : 0
  const inProgressCount = frame < 260 ? 0 : frame < 340 ? 2 : 0
  const doneCount = frame < 340 ? 0 : 2
  const cancelledCount = 0

  // Plus button highlight
  const plusHighlight = interpolate(frame, [35, 45, 110, 120], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Cursor 1: Add task 1
  const plusBtnX = COL_0 + COL_W - 28
  const plusBtnY = COL_Y + 22
  const cursor1X = interpolate(frame, [20, 42], [W / 2, plusBtnX], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const cursor1Y = interpolate(frame, [20, 42], [H / 2 + 100, plusBtnY], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const cursor1Opacity = interpolate(frame, [15, 25, 43, 48], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Dialog 1
  const d1Spring = spring({ frame: Math.max(0, frame - 48), fps: FPS, config: { damping: 18, stiffness: 200, mass: 0.7 }, durationInFrames: 25 })
  const d1Scale = interpolate(d1Spring, [0, 1], [0.94, 1])
  const d1Opacity = interpolate(frame, [48, 60, 110, 118], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const d1TitleChars = Math.floor(interpolate(frame, [60, 95], [0, TASK1_TITLE.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))
  const d1ButtonPulse = interpolate(frame, [98, 104, 109, 115], [0, 1, 0.5, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Card 1 entry
  const c1EntrySpring = spring({ frame: Math.max(0, frame - 118), fps: FPS, config: { damping: 20, stiffness: 180, mass: 0.8 }, durationInFrames: 30 })
  const c1Y = interpolate(c1EntrySpring, [0, 1], [COL_Y, CY0])
  const c1Opacity = ramp(frame, 118, 130)

  // Cursor 1 again: Add task 2
  const cursor1bOpacity = interpolate(frame, [125, 135, 143, 148], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Dialog 2
  const d2Spring = spring({ frame: Math.max(0, frame - 142), fps: FPS, config: { damping: 18, stiffness: 200, mass: 0.7 }, durationInFrames: 25 })
  const d2Scale = interpolate(d2Spring, [0, 1], [0.94, 1])
  const d2Opacity = interpolate(frame, [142, 154, 193, 201], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const d2TitleChars = Math.floor(interpolate(frame, [154, 185], [0, TASK2_TITLE.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }))
  const d2ButtonPulse = interpolate(frame, [186, 192, 197, 203], [0, 1, 0.5, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Card 2 entry
  const c2EntrySpring = spring({ frame: Math.max(0, frame - 201), fps: FPS, config: { damping: 20, stiffness: 180, mass: 0.8 }, durationInFrames: 30 })
  const c2Y = interpolate(c2EntrySpring, [0, 1], [COL_Y, CY0 + CARD_H + 12])
  const c2Opacity = ramp(frame, 201, 213)

  // Cursor 2: Select mode
  const selectBtnX = COL_0 + COL_W - 65
  const selectBtnY = COL_Y + 22
  const cursor2X = interpolate(frame, [208, 220], [W / 2, selectBtnX], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const cursor2Y = interpolate(frame, [208, 220], [H / 2, selectBtnY], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const cursor2Opacity = interpolate(frame, [205, 215, 228, 235], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const selectHighlight = interpolate(frame, [220, 228, 235, 242], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const showSelectMode = frame >= 220 && frame < 260
  const showCheckbox1 = frame >= 228
  const showCheckbox2 = frame >= 232
  const checked1 = frame >= 232
  const checked2 = frame >= 238

  // Batch controls
  const batchOpacity = interpolate(frame, [238, 248, 390, 400], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Execute Parallel button highlight and click
  const executeBtnX = BATCH_X + 230
  const executeBtnY = BATCH_Y + 26
  const cursor3X = interpolate(frame, [242, 255], [selectBtnX, executeBtnX], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const cursor3Y = interpolate(frame, [242, 255], [selectBtnY, executeBtnY], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const cursor3Opacity = interpolate(frame, [240, 250, 265, 272], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const executeHighlight = interpolate(frame, [252, 260, 268, 275], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  // Card movements
  // Phase 1: ALL_ISSUES positions
  const c1XAllIssues = COL_0 + CP
  const c2XAllIssues = COL_0 + CP

  // Phase 2: IN PROGRESS (start moving at frame 260)
  const slideToInProgressT1 = easeOut(frame, 260, 280)
  const c1X = frame < 260 ? c1XAllIssues : interpolate(slideToInProgressT1, [0, 1], [c1XAllIssues, COL_1 + CP])
  
  const slideToInProgressT2 = easeOut(frame, 262, 282)
  const c2X = frame < 262 ? c2XAllIssues : interpolate(slideToInProgressT2, [0, 1], [c2XAllIssues, COL_1 + CP])

  // Phase 3: Progress states during IN PROGRESS
  const progressState: ProgressState =
    frame >= 280 && frame < 295 ? "cloning" :
    frame >= 295 && frame < 310 ? "executing" :
    frame >= 310 && frame < 325 ? "creating_pr" :
    frame >= 325 && frame < 340 ? "done" :
    null

  // Phase 4: Slide to DONE
  const slideToDoneT1 = easeOut(frame, 325, 345)
  const c1XFinal = frame >= 325 ? interpolate(slideToDoneT1, [0, 1], [COL_1 + CP, COL_2 + CP]) : c1X
  
  const slideToDoneT2 = easeOut(frame, 327, 347)
  const c2XFinal = frame >= 327 ? interpolate(slideToDoneT2, [0, 1], [COL_1 + CP, COL_2 + CP]) : c2X

  // Individual card opacity (fade out when in DONE group)
  const c1IndividualOpacity = frame >= 345 ? interpolate(frame, [345, 355], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1
  const c2IndividualOpacity = frame >= 347 ? interpolate(frame, [347, 357], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1

  // Parallel Issues Group
  const groupOpacity = interpolate(frame, [345, 365], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  const prHighlight = interpolate(frame, [365, 375, 385, 395], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })

  const centerX = W / 2
  const col0Center = COL_0 + COL_W / 2
  const col1Center = COL_1 + COL_W / 2
  const col2Center = COL_2 + COL_W / 2
  const card1Y = CY0 + 100
  const card2Y = CY0 + CARD_H + 60
  const execY = CY0 + 80

  const zoom1Start = 48
  const zoom1End = 65
  const zoom1ReturnStart = 115
  const zoom1ReturnEnd = 130

  const zoom2Start = 142
  const zoom2End = 157
  const zoom2ReturnStart = 200
  const zoom2ReturnEnd = 215

  const zoom3Start = 250
  const zoom3End = 270
  const zoom3MoveStart = 275
  const zoom3MoveEnd = 295
  const zoom3ReturnStart = 345
  const zoom3ReturnEnd = 370

  let zoomLevel = 1.0
  if (frame < zoom1Start) zoomLevel = 1.0
  else if (frame < zoom1End) zoomLevel = interpolate(frame, [zoom1Start, zoom1End], [1.0, 1.25], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  else if (frame < zoom1ReturnStart) zoomLevel = 1.25
  else if (frame < zoom1ReturnEnd) zoomLevel = interpolate(frame, [zoom1ReturnStart, zoom1ReturnEnd], [1.25, 1.0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  else if (frame < zoom2Start) zoomLevel = 1.0
  else if (frame < zoom2End) zoomLevel = interpolate(frame, [zoom2Start, zoom2End], [1.0, 1.25], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  else if (frame < zoom2ReturnStart) zoomLevel = 1.25
  else if (frame < zoom2ReturnEnd) zoomLevel = interpolate(frame, [zoom2ReturnStart, zoom2ReturnEnd], [1.25, 1.0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  else if (frame < zoom3Start) zoomLevel = 1.0
  else if (frame < zoom3End) zoomLevel = interpolate(frame, [zoom3Start, zoom3End], [1.0, 1.35], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  else if (frame < zoom3ReturnStart) zoomLevel = 1.35
  else if (frame < zoom3ReturnEnd) zoomLevel = interpolate(frame, [zoom3ReturnStart, zoom3ReturnEnd], [1.35, 1.0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" })
  else zoomLevel = 1.0

  let focusX = centerX
  let focusY = H / 2

  if (frame >= zoom1Start && frame < zoom1ReturnEnd) {
    focusX = col0Center
    focusY = card1Y
  } else if (frame >= zoom2Start && frame < zoom2ReturnEnd) {
    focusX = col0Center
    focusY = card2Y
  } else if (frame >= zoom3Start && frame < zoom3MoveStart) {
    focusX = col0Center
    focusY = card1Y
  } else if (frame >= zoom3MoveStart && frame < zoom3MoveEnd) {
    const t = easeOut(frame, zoom3MoveStart, zoom3MoveEnd)
    focusX = interpolate(t, [0, 1], [col0Center, col1Center])
    focusY = execY
  } else if (frame >= zoom3MoveEnd && frame < 325) {
    focusX = col1Center
    focusY = execY
  } else if (frame >= 325 && frame < zoom3ReturnEnd) {
    const t = easeOut(frame, 325, 345)
    focusX = interpolate(t, [0, 1], [col1Center, col2Center])
    focusY = execY
  }

  const cameraX = W / 2 - focusX * zoomLevel
  const cameraY = H / 2 - focusY * zoomLevel

  return (
    <AbsoluteFill style={{ backgroundColor: C.boardBg, opacity: globalOpacity }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <filter id="dlg-shadow" x="-20%" y="-20%" width="140%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="16" />
          </filter>
          {[0, 1, 2, 3].map((i) => (
            <linearGradient key={`cg-def-${i}`} id={`col-grad-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgba(255,255,255,0.015)" />
              <stop offset="100%" stopColor="rgba(0,0,0,0)" />
            </linearGradient>
          ))}
        </defs>

        <rect x={0} y={0} width={W} height={H} fill={C.boardBg} />

        {/* Camera transform group */}
        <g transform={`translate(${cameraX}, ${cameraY}) scale(${zoomLevel})`}>

        {/* Column backgrounds */}
        {[0, 1, 2, 3].map((i) => (
          <rect key={`col-bg-${i}`} x={COL_0 + i * COL_W} y={COL_Y} width={COL_W} height={COL_H} fill={`url(#col-grad-${i})`} />
        ))}

        <Sidebar opacity={1} />
        <TopBar opacity={1} />
        <ConfigStrip opacity={1} workflowValue={workflowValue} selectionValue={selectionValue} />
        <ColumnDividers />

        {/* Column headers */}
        <ColHeader x={COL_0} title="All Issues" count={allIssuesCount} plusHighlight={plusHighlight} 
          showSelect={showSelectMode} selectHighlight={selectHighlight} />
        <ColHeader x={COL_1} title="In Progress" count={inProgressCount} />
        <ColHeader x={COL_2} title="Done" count={doneCount} />
        <ColHeader x={COL_3} title="Cancelled" count={cancelledCount} />

        {/* Empty states */}
        {allIssuesCount === 0 && <EmptyState x={COL_0} />}
        {inProgressCount === 0 && <EmptyState x={COL_1} />}
        {doneCount === 0 && <EmptyState x={COL_2} />}
        {cancelledCount === 0 && <EmptyState x={COL_3} />}

        {/* Card 1 */}
        {frame >= 118 && frame < 355 && (
          <TaskCard
            x={c1XFinal}
            y={c1Y}
            opacity={c1Opacity * c1IndividualOpacity}
            title={TASK1_TITLE}
            identifier={TASK1_ID}
            showCheckbox={showCheckbox1}
            checked={checked1}
            progressState={frame >= 280 && frame < 325 ? progressState : frame >= 325 ? "done" : null}
            isDone={frame >= 325}
          />
        )}

        {/* Card 2 */}
        {frame >= 201 && frame < 357 && (
          <TaskCard
            x={c2XFinal}
            y={c2Y}
            opacity={c2Opacity * c2IndividualOpacity}
            title={TASK2_TITLE}
            identifier={TASK2_ID}
            showCheckbox={showCheckbox2}
            checked={checked2}
            progressState={frame >= 280 && frame < 325 ? progressState : frame >= 325 ? "done" : null}
            isDone={frame >= 325}
          />
        )}

        {/* Parallel Issues Group */}
        {frame >= 345 && (
          <ParallelIssuesGroup
            x={COL_2 + CP}
            y={CY0}
            opacity={groupOpacity}
            prHighlight={prHighlight}
          />
        )}

        {/* Dialogs */}
        {frame >= 48 && frame <= 118 && (
          <TaskFormDialog
            scale={d1Scale}
            opacity={d1Opacity}
            title={TASK1_TITLE}
            titleChars={d1TitleChars}
            buttonPulse={d1ButtonPulse}
          />
        )}

        {frame >= 142 && frame <= 203 && (
          <TaskFormDialog
            scale={d2Scale}
            opacity={d2Opacity}
            title={TASK2_TITLE}
            titleChars={d2TitleChars}
            buttonPulse={d2ButtonPulse}
          />
        )}

        {/* Batch Controls */}
        {frame >= 238 && (
          <BatchControls
            opacity={batchOpacity}
            selectedCount={2}
            executeParallelHighlight={executeHighlight}
          />
        )}

        </g>

        {/* Cursors - outside camera transform so they stay fixed size */}
        <ArrowCursor x={cursor1X} y={cursor1Y} opacity={cursor1Opacity} />
        <ArrowCursor x={cursor1X} y={cursor1Y} opacity={cursor1bOpacity} />
        <ArrowCursor x={cursor2X} y={cursor2Y} opacity={cursor2Opacity} />
        <ArrowCursor x={cursor3X} y={cursor3Y} opacity={cursor3Opacity} />
      </svg>
    </AbsoluteFill>
  )
}

export default HowItWorksAnimation
