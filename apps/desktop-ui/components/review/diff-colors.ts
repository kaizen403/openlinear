import type { DiffFileStatus } from "@/lib/api/review"
import type { CheckStatus } from "./model/checks"
import type { TokenKind } from "./model/syntax"

/**
 * Every colour the review kit uses, in one place, as SEMANTIC Tailwind
 * classes (theme tokens + opacity modifiers) — no hex/arbitrary colours and
 * no raw palette colours. When the design-token system lands, remap the
 * roles below (success → `success`, danger → `danger`, warning → `warning`)
 * here (done: tones map to the verified `success`/`danger`/`warning`/`info`
 * tokens); components only import roles.
 *
 * review-kit.test.mjs checks WCAG contrast of each role against the base
 * theme values and that no file under components/review uses a hex or raw
 * palette colour class.
 */

/** Text roles. Opacity over `foreground` keeps AA on every review surface. */
export const TEXT = {
  primary: "text-foreground",
  secondary: "text-linear-text-secondary",
  muted: "text-muted-foreground",
  placeholder: "placeholder:text-muted-foreground",
} as const

export type Tone = "success" | "danger" | "warning" | "info"

/** Status tones: text, icon and a tinted surface (badge/box). Never the only signal — always with a label or icon. */
export const TONE: Readonly<Record<Tone, { text: string; surface: string }>> = {
  // Mapped to the contrast-verified tone tokens (lib/design, docs/design-tokens.md).
  success: { text: "text-success", surface: "border-success/30 bg-success/10" },
  danger: { text: "text-danger", surface: "border-danger/30 bg-danger/10" },
  warning: { text: "text-warning", surface: "border-warning/30 bg-warning/10" },
  info: { text: "text-info", surface: "border-info/30 bg-info/10" },
}

/** Surfaces and interaction fills. */
export const SURFACE = {
  panel: "bg-background",
  raised: "bg-card",
  hover: "hover:bg-foreground/5",
  selected: "bg-foreground/10",
  emptyHalf: "bg-foreground/[0.02]",
  stickyHeader: "bg-background/95",
} as const

export const BUTTON = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  /** A publish action enabled only by the explicit override. */
  overridden: "border border-foreground/40 bg-foreground/10 text-foreground hover:bg-foreground/15",
  ghost: "text-linear-text-secondary hover:bg-foreground/5 hover:text-foreground",
  danger: "text-linear-text-secondary hover:bg-foreground/5 hover:text-destructive",
} as const

// ─── Diff ─────────────────────────────────────────────────────────────────────

export const DIFF_LINE_BG = {
  context: "",
  add: "bg-success/[0.12]",
  del: "bg-danger/[0.12]",
} as const

export const DIFF_GUTTER_BG = {
  context: "",
  add: "bg-primary/[0.18]",
  del: "bg-destructive/[0.18]",
} as const

export const HUNK_HEADER = "bg-foreground/5 text-linear-text-secondary"
export const GUTTER_TEXT = "text-muted-foreground"

/**
 * Syntax-light roles within the semantic palette (green is the only hue that
 * isn't reserved for removals): keywords and numbers in the accent, strings
 * a step dimmer than code, comments dim and italic.
 */
export const SYNTAX_TEXT: Readonly<Record<TokenKind, string>> = {
  plain: "text-foreground",
  // `brand` is the text-safe bright accent; `primary` is the solid fill colour.
  keyword: "text-brand",
  string: "text-linear-text-secondary",
  number: "text-brand",
  comment: "text-muted-foreground italic",
}

export const ADDITIONS_TEXT = TONE.success.text
export const DELETIONS_TEXT = TONE.danger.text

export const FILE_STATUS_MARK: Readonly<Record<DiffFileStatus, { letter: string; label: string; className: string }>> = {
  added: { letter: "A", label: "Added", className: TONE.success.text },
  modified: { letter: "M", label: "Modified", className: TEXT.primary },
  deleted: { letter: "D", label: "Deleted", className: TONE.danger.text },
  renamed: { letter: "R", label: "Renamed", className: TEXT.secondary },
  binary: { letter: "B", label: "Binary", className: TEXT.muted },
}

export const CHECK_TONE: Readonly<Record<CheckStatus, string>> = {
  passed: TONE.success.text,
  failed: TONE.danger.text,
  running: TONE.info.text,
  pending: TONE.info.text,
  missing: TONE.warning.text,
  warning: TONE.warning.text,
  stale: TONE.warning.text,
}

export const DRAFT_BADGE = `${TONE.warning.surface} ${TONE.warning.text}`
