import type { PhaseTone } from "@/lib/run-model"
import type { FileChangeKind } from "@/lib/run-model"
import { tokenHex } from "@/lib/design/tokens"

/**
 * Colour tokens for the agent-execution kit, wired to the design tokens
 * (`run-*` component tokens; lib/design/tokens.ts). Each `hex` is the token's
 * resolved value, so `run-kit.test` checks the colours the UI really paints:
 * every text colour is ≥ 4.5:1 on the dark surfaces and on its own tinted pill.
 * lib/design/tokens.test.ts checks the same pairs across the whole token set.
 */
export interface TextToken {
  className: string
  hex: string
}

export const KIT_TEXT = {
  primary: { className: "text-linear-text", hex: tokenHex("linear-text") },
  secondary: { className: "text-linear-text-secondary", hex: tokenHex("linear-text-secondary") },
  /** Metadata: timestamps, durations, counters (tertiary text, ≥ 4.5:1). */
  muted: { className: "text-linear-text-tertiary", hex: tokenHex("linear-text-tertiary") },
} as const satisfies Record<string, TextToken>

export const TONE_TEXT: Readonly<Record<PhaseTone, TextToken>> = {
  neutral: { className: "text-run-neutral", hex: tokenHex("run-neutral") },
  info: { className: "text-run-info", hex: tokenHex("run-info") },
  active: { className: "text-run-active", hex: tokenHex("run-active") },
  warning: { className: "text-run-warning", hex: tokenHex("run-warning") },
  success: { className: "text-run-success", hex: tokenHex("run-success") },
  danger: { className: "text-run-danger", hex: tokenHex("run-danger") },
}

/** Pill surfaces: 10% tint + 30% border of the tone; text from TONE_TEXT. */
export const TONE_SURFACE: Readonly<Record<PhaseTone, string>> = {
  neutral: "bg-run-neutral/10 border-run-neutral/30",
  info: "bg-run-info/10 border-run-info/30",
  active: "bg-run-active/10 border-run-active/30",
  warning: "bg-run-warning/10 border-run-warning/30",
  success: "bg-run-success/10 border-run-success/30",
  danger: "bg-run-danger/10 border-run-danger/30",
}

/** The tint colours behind TONE_SURFACE, for the contrast test (10% over #111111). */
export const TONE_TINT_HEX: Readonly<Record<PhaseTone, string>> = {
  neutral: tokenHex("run-neutral"),
  info: tokenHex("run-info"),
  active: tokenHex("run-active"),
  warning: tokenHex("run-warning"),
  success: tokenHex("run-success"),
  danger: tokenHex("run-danger"),
}

export const FILE_CHANGE_MARK: Readonly<Record<FileChangeKind, { letter: string; label: string; tone: PhaseTone }>> = {
  added: { letter: "A", label: "Added", tone: "success" },
  modified: { letter: "M", label: "Modified", tone: "warning" },
  deleted: { letter: "D", label: "Deleted", tone: "danger" },
}

/** Surfaces the kit renders text on: canvas, inset, app, raised, hover. */
export const KIT_SURFACES_HEX = [
  tokenHex("background"),
  tokenHex("linear-bg-tertiary"),
  tokenHex("linear-bg"),
  tokenHex("linear-bg-secondary"),
  tokenHex("surface-hover"),
] as const
