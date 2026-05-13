/**
 * OpenLinear semantic design tokens.
 *
 * Single source of truth for status/priority color classes and elevation
 * shadows. All UI surfaces should import from this module instead of
 * hand-rolling tailwind class strings or inline hex literals.
 *
 * Tokens use the `linear-*` namespace (which respects the runtime
 * `--linear-accent` CSS variable) plus semantic shadcn tokens.
 */

export type StatusKey =
  | "todo"
  | "in_progress"
  | "done"
  | "cancelled"
  | "error"
  | "cloning"
  | "executing"
  | "committing"
  | "creating_pr"

export type PriorityKey = "low" | "medium" | "high" | "urgent"

export type TeamRoleKey = "owner" | "admin" | "member"

export type ProjectStatusKey =
  | "planned"
  | "in_progress"
  | "paused"
  | "completed"
  | "cancelled"

export interface ColorTriad {
  /** Background tailwind class (10% opacity). */
  bg: string
  /** Text tailwind class. */
  text: string
  /** Border tailwind class. */
  border: string
  /** Solid dot/indicator background class. */
  dot: string
}

export const STATUS_COLORS: Readonly<Record<StatusKey, ColorTriad>> = {
  todo: {
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border",
    dot: "bg-muted-foreground",
  },
  in_progress: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
    dot: "bg-blue-400",
  },
  done: {
    bg: "bg-green-500/10",
    text: "text-green-400",
    border: "border-green-500/30",
    dot: "bg-green-400",
  },
  cancelled: {
    bg: "bg-gray-500/10",
    text: "text-gray-400",
    border: "border-gray-500/30",
    dot: "bg-gray-400",
  },
  error: {
    bg: "bg-red-500/10",
    text: "text-red-400",
    border: "border-red-500/30",
    dot: "bg-red-400",
  },
  cloning: {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
    dot: "bg-blue-400",
  },
  executing: {
    bg: "bg-linear-accent/10",
    text: "text-linear-accent",
    border: "border-linear-accent/30",
    dot: "bg-linear-accent",
  },
  committing: {
    bg: "bg-yellow-500/10",
    text: "text-yellow-400",
    border: "border-yellow-500/30",
    dot: "bg-yellow-400",
  },
  creating_pr: {
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    border: "border-purple-500/30",
    dot: "bg-purple-400",
  },
} as const

export const PRIORITY_COLORS: Readonly<Record<PriorityKey, ColorTriad>> = {
  low: {
    bg: "bg-muted",
    text: "text-muted-foreground",
    border: "border-border",
    dot: "bg-muted-foreground",
  },
  medium: {
    bg: "bg-sky-500/10",
    text: "text-sky-400",
    border: "border-sky-500/30",
    dot: "bg-sky-400",
  },
  high: {
    bg: "bg-amber-500/10",
    text: "text-amber-400",
    border: "border-amber-500/30",
    dot: "bg-amber-400",
  },
  urgent: {
    bg: "bg-destructive/10",
    text: "text-destructive",
    border: "border-destructive/40",
    dot: "bg-destructive",
  },
} as const

export const TEAM_ROLE_COLORS: Readonly<Record<TeamRoleKey, ColorTriad>> = {
  owner: PRIORITY_COLORS.high,
  admin: STATUS_COLORS.in_progress,
  member: STATUS_COLORS.todo,
} as const

export const PROJECT_STATUS_COLORS: Readonly<Record<ProjectStatusKey, ColorTriad>> = {
  planned: STATUS_COLORS.todo,
  in_progress: STATUS_COLORS.in_progress,
  paused: STATUS_COLORS.committing,
  completed: STATUS_COLORS.done,
  cancelled: STATUS_COLORS.cancelled,
} as const

/**
 * Semantic shadow utilities. The actual shadow values are wired in
 * `tailwind.config.ts` under `theme.extend.boxShadow`.
 */
export const SHADOWS = {
  card: "shadow-card",
  overlay: "shadow-overlay",
  elevation: "shadow-elevation",
} as const

export type ShadowKey = keyof typeof SHADOWS

/** Brand colors with no semantic linear-* equivalent; use as inline style. */
export const BRAND_COLORS = {
  macClose: "#ff5f57",
  macMinimize: "#febc2e",
  macMaximize: "#28c840",
  githubBg: "#24292e",
  githubBgHover: "#1b1f23",
  githubPurple: "#8957e5",
  githubPurpleHover: "#7c4dcc",
  overlaySurface: "#09090b",
} as const

/** Batch-execution status colors (distinct semantic from STATUS_COLORS). */
export const BATCH_STATUS_COLORS = {
  queued: { text: "text-linear-text-tertiary", bg: "bg-linear-border" },
  running: { text: "text-linear-accent", bg: "bg-linear-accent" },
  completed: { text: "text-green-400", bg: "bg-green-500/10", dot: "bg-green-500" },
  failed: { text: "text-red-400", bg: "bg-red-500/10", dot: "bg-red-500" },
  skipped: { text: "text-amber-400", bg: "bg-amber-500/10" },
  cancelled: { text: "text-linear-text-tertiary", bg: "bg-linear-border-hover" },
} as const
