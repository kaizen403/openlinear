// Design tokens: OKLCH primitives → semantic → component tiers, the generated
// CSS block, and the WCAG contrast contract. See docs/design-tokens.md.
// Client code that only needs a token's hex should import from "./tokens"
// (no contrast tables are built at import time there).
export * from "./color"
export { PRIMITIVES, PRIMITIVE_HEX, type PrimitiveName } from "./palette"
export {
  COMPONENT,
  RUNTIME_INPUTS,
  SEMANTIC,
  STATE,
  STATE_LAYER,
  resolvePrimitive,
  resolveToken,
  tokenHex,
  type ComponentName,
  type RuntimeInputName,
  type SemanticName,
  type StateLayerName,
  type StateName,
  type TokenName,
} from "./tokens"
export { ACCENT_PRESETS, DEFAULT_ACCENT, solidFor, textSafe, type AccentPreset } from "./accent"
export {
  ACCENT_MIGRATION_TABLE,
  ACCENT_STORAGE_KEY,
  LEGACY_BLUE_ACCENTS,
  LEGACY_PRESET_VALUES,
  accentBootScript,
  migrateStoredAccent,
  type StoredAccent,
} from "./accent-migration"
export {
  ACCENT_PAIRS,
  CONTRAST_PAIRS,
  CONTROL_SURFACES,
  MINIMUM,
  TEXT_SURFACES,
  TINTED_TEXT,
  describePaint,
  evaluateAccentPresets,
  evaluatePairs,
  resolverForAccent,
  type ContrastPair,
  type ContrastResult,
  type PairKind,
  type Paint,
  type PresetResult,
  type Resolver,
} from "./contrast"
export { TOKENS_END, TOKENS_START, extractTokenBlock, renderTokenCss, replaceTokenBlock } from "./css"
