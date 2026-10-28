/**
 * OpenLinear semantic design tokens.
 *
 * Single source of truth for status/priority color classes and elevation
 * shadows. All UI surfaces should import from this module instead of
 * hand-rolling tailwind class strings or inline hex literals.
 *
 * Colours are the design-token component tier (`status-*`, `priority-*`,
 * `run-*`; lib/design/tokens.ts, contrast-checked by lib/design/tokens.test.ts).
 * Class names are written out in full so Tailwind can see them. Coloured
 * chips tint their own token at /10 (background) and /30 (border); neutral
 * ones (todo, low) sit on `bg-muted`.
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
    text: "text-status-todo",
    border: "border-border",
    dot: "bg-status-todo",
  },
  in_progress: {
    bg: "bg-status-in-progress/10",
    text: "text-status-in-progress",
    border: "border-status-in-progress/30",
    dot: "bg-status-in-progress",
  },
  done: {
    bg: "bg-status-done/10",
    text: "text-status-done",
    border: "border-status-done/30",
    dot: "bg-status-done",
  },
  cancelled: {
    bg: "bg-status-cancelled/10",
    text: "text-status-cancelled",
    border: "border-status-cancelled/30",
    dot: "bg-status-cancelled",
  },
  error: {
    bg: "bg-status-error/10",
    text: "text-status-error",
    border: "border-status-error/30",
    dot: "bg-status-error",
  },
  cloning: {
    bg: "bg-status-in-progress/10",
    text: "text-status-in-progress",
    border: "border-status-in-progress/30",
    dot: "bg-status-in-progress",
  },
  executing: {
    bg: "bg-status-in-progress/10",
    text: "text-status-in-progress",
    border: "border-status-in-progress/30",
    dot: "bg-status-in-progress",
  },
  committing: {
    bg: "bg-status-committing/10",
    text: "text-status-committing",
    border: "border-status-committing/30",
    dot: "bg-status-committing",
  },
  creating_pr: {
    bg: "bg-status-publishing/10",
    text: "text-status-publishing",
    border: "border-status-publishing/30",
    dot: "bg-status-publishing",
  },
} as const

export const PRIORITY_COLORS: Readonly<Record<PriorityKey, ColorTriad>> = {
  low: {
    bg: "bg-muted",
    text: "text-priority-low",
    border: "border-border",
    dot: "bg-priority-low",
  },
  medium: {
    bg: "bg-priority-medium/10",
    text: "text-priority-medium",
    border: "border-priority-medium/30",
    dot: "bg-priority-medium",
  },
  high: {
    bg: "bg-priority-high/10",
    text: "text-priority-high",
    border: "border-priority-high/30",
    dot: "bg-priority-high",
  },
  urgent: {
    bg: "bg-priority-urgent/10",
    text: "text-priority-urgent",
    border: "border-priority-urgent/30",
    dot: "bg-priority-urgent",
  },
} as const

export const TEAM_ROLE_COLORS: Readonly<Record<TeamRoleKey, ColorTriad>> = {
  owner: STATUS_COLORS.todo,
  admin: STATUS_COLORS.todo,
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

/** Third-party brand colours (macOS window controls, GitHub); fixed, not themable. */
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
  running: { text: "text-run-active", bg: "bg-run-active" },
  completed: { text: "text-run-success", bg: "bg-run-success/10", dot: "bg-run-success" },
  failed: { text: "text-run-danger", bg: "bg-run-danger/10", dot: "bg-run-danger" },
  skipped: { text: "text-run-warning", bg: "bg-run-warning/10" },
  cancelled: { text: "text-linear-text-tertiary", bg: "bg-linear-border-hover" },
} as const
