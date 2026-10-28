# Contrast-verified three-tier design tokens (engineer `tokens`, round 4)

**Status:** done for this slice. Uncommitted, frontend only (`apps/desktop-ui`), nothing deployed.

**Base tree:** `db77ae5` (HEAD `922dbd7` plus `round4-base.patch`). The brand hue is unchanged (emerald `#10b981`), and the project stays on Tailwind 3.4.

**Reference doc:** `apps/desktop-ui/docs/design-tokens.md`. It covers the tiers, the contrast rule, how to add a token, how to change the accent in one place, and why the runtime CSS uses sRGB channels.

## Outcome

- **One token source in TypeScript** (`lib/design/`). The CSS variables in `app/globals.css` are generated from it. `tailwind.config.ts` maps every Tailwind colour to a variable: 8 hard-coded hex values became 0. The roughly 2,370 existing `linear-*` / shadcn class usages resolve to tokens with no class churn.
- **Contrast is a test.** `lib/design/tokens.test.ts` (16 tests) evaluates 429 pairs:
  - 417 are enforced (text 4.5:1, UI 3:1);
  - 12 decorative pairs are reported only;
  - all 8 accent presets are re-checked: 792 preset × pair checks.

  The test also fails on generated-CSS drift, unknown Tailwind token names, orphan primitives, tier violations, and any `bg-[#…]`-style hex class in `app/` or `components/`. **Before: 100 enforced pairs failed. After: 0.**
- **States are tokens.** `--state-hover` (0.9), `--state-pressed` (0.8) and `--state-disabled` (0.5) back `hover:bg-primary-hover`, `active:bg-primary-pressed`, `hover:bg-destructive-hover`, `hover:bg-linear-accent-hover` and `disabled:opacity-disabled`. Hover and pressed are derived from the solid, so they stay correct for every picker accent.
- **Status colours are tokens.** Run phases (`run-*`), board status and priority (`status-*`, `priority-*`), tones (`success`, `warning`, `danger`/`destructive`, `info`, `discovery`), surfaces and state layers (`surface-*`) are wired into the execution kit, `lib/design-tokens.ts` and the board components. Layouts are unchanged.
- **Hard-coded colours removed from `components/`.** Arbitrary hex classes went from 41 to 0 and Tailwind palette classes from 190 to 0. See the counts below.

## Tier design

Three tiers sit above a set of runtime inputs (the accent picker).

### Tier 1: primitives (`palette.ts`)

- 24 colours, authored in OKLCH and named `<hue>-<L>` (L = OKLCH lightness × 100), e.g. `neutral-63`, `emerald-55`.
- The test checks each one: it round-trips to its hex, sits in the sRGB gamut, has a name within ±1 of its L, and is used by a semantic token.
- They are emitted as `--ol-*: R G B; /* #hex oklch(...) */`.

### Runtime inputs

The accent picker writes `--linear-accent{,-rgb}` (brand) and `--linear-accent-hover{,-rgb}` (the solid accent; the name is legacy). The defaults are `emerald-70` / `emerald-55`.

### Tier 2: semantic (34 tokens)

| Group | Tokens |
|---|---|
| Surfaces | `surface-overlay`, `-canvas`, `-card`, `-inset`, `-app`, `-raised`, `-hover`, `-pressed` |
| Text | `fg-primary`, `fg-default`, `fg-secondary`, `fg-tertiary`, `fg-on-solid`, `fg-on-inverse` |
| Borders | `border-subtle`, `-default`, `-strong`, `-control` (3:1), `-focus` |
| Accent | `accent-brand`, `accent-solid` |
| Tones | `tone-neutral`, `-info`, `-success`, `-warning`, `-danger`, `-danger-solid`, `-discovery` |

### Tier 3: component and role tokens (57)

- shadcn roles: `background`, `primary`, `accent`, `destructive{,-solid}`, `input`, `ring`, and the rest.
- `brand` and `brand-solid`.
- The legacy `linear-*` names.
- `status-*` (7), `priority-*` (4), `run-*` (6).
- `scrollbar-thumb{,-hover}`.

### Tailwind mapping

`token(name)` produces `rgb(var(--name) / <alpha-value>)`, so opacity modifiers keep working.

For two legacy names a background resolves differently from text and borders (`backgroundColor` in the config):

| Name | Background | Text / border |
|---|---|---|
| `linear-accent` | the solid (`--brand-solid`) | the brand |
| `destructive` | `--destructive-solid` | text-safe red |

This one rule fixed all 39 `bg-linear-accent … text-white` buttons and the 6 `bg-destructive` buttons, including 12 + 4 in `app/` pages outside this ownership, without touching them. It also made the ~30 `text-destructive` usages AA.

### OKLCH at runtime: checked, deliberately not used

- Tauri's macOS floor is 10.15, so WKWebView can predate `oklch()` (Safari 15.4).
- A `var()`-based colour can't fall back per declaration: an unsupported function makes the property `unset`, not the earlier `rgb()`.
- Tailwind 3's `<alpha-value>` needs one function per colour.
- All tokens are in the sRGB gamut, so the pixels would be identical.

OKLCH is therefore the authoring space (lightness-only adjustments, names). The switch to `oklch()` channels later is two functions: `toChannels` in `css.ts` and `token()` in `tailwind.config.ts`.

### Lightness-only fixes within the same hue

| Token | Before | After | Change |
|---|---|---|---|
| Accent solid | — | `#03855b` | `emerald-55`: same hue as `#10b981` (162.48°), L 0.696 → 0.546, chroma reduced only to stay in gamut. White on it is 4.66:1, 5.29:1 at hover, 6.02:1 pressed. |
| Tertiary / muted text | `#6a6a6a` / `#595959` | `#8a8a8a` | — |
| Control boundary | `#1f1f1f` | `#6a6a6a` | — |
| Danger text | `#d31212` | `#f87171` | The `#d31212` fill is kept for solids. |
| Accent presets | — | Purple `#a07fff`, Pink `#f954a4`, Red `#ff5754` | Lightened within hue. |
| Preset solids | — | Green `#02873b`, Orange `#c05402`, Pink `#d42e85`, Teal `#008376`, Yellow `#936f02` | Darkened within hue. |

Purple `#7c3aed` and Red `#dc2626` already passed and are kept. The test enforces same hue (≤ 3°) and a lower L for every solid.

## Contrast: pairs that failed before

From `node scripts/design-tokens.mjs --report`, grouped by foreground. "Worst" is the minimum over the surfaces in the group. Hover and pressed rows are the solid at the state alpha over each surface.

| Foreground (token) | Used for | Pairs failing before | Worst before | Worst after | Min |
|---|---|---|---|---|---|
| `input` #1f1f1f → #6a6a6a | input / select / textarea / checkbox boundary, switch track (off), slider track | 7 | 1.06 | 3.22 | 3 |
| `background` (switch thumb) on `input` | switch thumb on the off track | 1 | 1.20 | 3.66 | 3 |
| `muted-foreground` #595959 → #8a8a8a | text ladder (placeholders, tabs) | 8 | 2.35 | 4.77 | 4.5 |
| `status-todo`, `priority-low` #595959 → #8a8a8a | neutral status / priority chip | 16 | 2.35 | 4.77 | 4.5 |
| `primary-foreground` on `primary` (#10b981 → #03855b) | primary button, badge, checked selection, `bg-linear-accent` | 1 | 2.54 | 4.66 | 4.5 |
| `accent-foreground` on `accent` | menu highlight, ghost/outline hover | 1 | 2.54 | 4.66 | 4.5 |
| `muted-foreground` on `muted` | tabs list, muted panels | 1 | 2.77 | 5.63 | 4.5 |
| `primary-` / `accent-foreground`, hover | the same fills at hover | 16 | 2.98 | 5.29 | 4.5 |
| `destructive`, `priority-urgent` #d31212 → #f87171 | text, icons, dots | 16 | 3.03 | 5.96 | 4.5 |
| `destructive`, `priority-urgent` on own 10 % / 20 % tint | error banners, urgent chips | 8 | 3.00 | 4.89 | 4.5 |
| `linear-text-tertiary` #6a6a6a → #8a8a8a | text ladder (484 usages) | 8 | 3.05 | 4.77 | 4.5 |
| `linear-text-tertiary` on brand 10 % | selected card / row metadata | 1 | 3.06 | 4.79 | 4.5 |
| `primary-` / `accent-foreground`, pressed | the same fills pressed | 16 | 3.58 | 6.02 | 4.5 |

Total: 100 failing pairs before, 0 after.

### Tightest pairs after

All pass:

| Pair | Ratio | Min |
|---|---|---|
| `input` on `surface-hover` | 3.22 | 3 |
| switch thumb on track | 3.66 | 3 |
| `primary` as a fill vs `surface-hover` | 3.74 | 3 |
| white on the solid | 4.66 | 4.5 |
| tertiary on `surface-pressed` | 4.77 | 4.5 |
| danger on its 20 % tint | 4.89 | 4.5 |
| brand on its 20 % tint | 5.27 | 4.5 |
| destructive button | 5.43 | 4.5 |
| focus ring, worst case | 13.94 | 3 |

### Presets, worst check

| Preset | Pair | Ratio |
|---|---|---|
| Purple | brand on its 20 % tint | 4.55 |
| Red | brand on its 20 % tint | 4.56 |
| Pink | brand on its 20 % tint | 4.57 |
| Every other preset | — | ≥ 4.63 |

### Decorative (not enforced, reported)

| Border | Ratio |
|---|---|
| `border` #1f1f1f | 1.12–1.20 |
| `linear-border` #2a2a2a | 1.28–1.38 |
| `linear-border-hover` #3a3a3a | 1.62–1.74 |

They are separators and card outlines. Every control boundary uses `border-input` (≥ 3:1).

## Hard-coded colours replaced

From `node scripts/design-tokens.mjs --inventory` (`app/`, `components/`, `lib/`, excluding tests and `lib/design`):

| Metric | Before | After | Notes |
|---|---|---|---|
| Hex literals in `tailwind.config.ts` (`linear.*` palette) | 8 | **0** | — |
| `linear-*` utilities resolving to hard-coded hex | 2,378 | **0** | All 2,370 remaining usages resolve to tokens. |
| Arbitrary hex classes (`bg-[#1a1a1a]`, `border-[#2a2a2a]`, …) | 41 | **0** | Now guarded by the test. |
| Tailwind palette classes (`text-red-400`, `bg-emerald-500/10`, …) | 287 (components 190, lib 32, app 65) | **65** | Components 0, lib 0. The 65 left are in `app/` pages (not this ownership). |
| Hex literals in TS/TSX | 122 (components 90) | 38 (components 6) | The rest are user-data colours (team and label palettes), the third-party `BRAND_COLORS`, the legacy-accent migration set, and comments. |
| Raw hex in `globals.css` outside the token block | 4 | **0** | `html` background and scrollbar thumb/hover. |
| `bg-linear-accent … text-white` below 4.5:1 | 39 | **0** | 37 call sites keep the class and now resolve to the solid. |

Edits that produced these counts:

| Edit | Changes |
|---|---|
| Codemod: palette shades 200–600 → tones, variants and opacity kept | 124 class swaps in 31 files |
| Reviewed manual swaps | 59 (batch bars and pills, selection bar, execution monitor, brainstorm priorities, PAT revoke button, run timeline, task-card checkbox, onboarding radio, project colour fallback) |
| Primitives | 10 files in `components/ui` |
| Token maps | `lib/design-tokens.ts` and `components/execution/tokens.ts` (`hex` fields now come from `tokenHex()`, so `run-kit.test` checks the real colours) |
| Appearance presets | moved to `lib/design/accent.ts` |
| `theme-meta` | now reads the canvas token |

## Screenshots

**How they were made:**

- Headless Chrome, fixture data, real components.
- The real Tailwind build: `tailwind.config.ts` + `app/globals.css`, bundled Anthropic Sans.
- Harness: `lib/design/token-screenshots.capture.test.mjs`, opt-in and skipped in the normal suite. It renders real components in jsdom with module mocks, serialises the DOM, and screenshots it with Chrome:

  ```sh
  TOKENS_SCREENSHOTS=before|after pnpm --filter @openlinear/desktop-ui exec vitest run lib/design/token-screenshots.capture.test.mjs
  ```

**What they show:**

| Surface | What it is |
|---|---|
| Board | `KanbanBoard` |
| Task detail | `TaskDetailView` with the live run view |
| Chat | `ChatPanel`: tool rows, confirmation card, composer |
| Settings | the AI Execution page: sliders, switches, select |
| Specimen | every button, badge and control state, the status/priority/batch/run chips, and text on each surface |

Every file is under 160 KB:

| Surface | Before | After |
|---|---|---|
| Board | `tokens-board-before.png` | `tokens-board-after.png` |
| Task detail + run view | `tokens-detail-before.png` | `tokens-detail-after.png` |
| Chat panel | `tokens-chat-before.png` | `tokens-chat-after.png` |
| Settings | `tokens-settings-before.png` | `tokens-settings-after.png` |
| Token specimen | `tokens-specimen-before.png` | `tokens-specimen-after.png` |

**Visible changes:**

- Primary buttons, badges, the chat Confirm button and menu highlights use the deeper emerald solid with white text.
- Tertiary and muted text is lighter.
- Input, select, textarea and checkbox boundaries, and switch and slider tracks, are visible (`#6a6a6a`).
- Destructive and error text is `#f87171`.
- The run "active" pill follows the brand (`#10b981`, and any picker accent) instead of a fixed emerald-400.
- The "committing" status is amber (it was yellow).

**Unchanged:** layout, the surfaces ladder, borders, the brand emerald on text, focus rings, indicators and borders.

## How to change the accent in one place

1. Run `node scripts/design-tokens.mjs --suggest '<hex>'`.
2. Replace `emerald-70` (brand) and `emerald-55` (solid) in `lib/design/palette.ts`, and repoint `RUNTIME_INPUTS` in `lib/design/tokens.ts`.
3. Run `node scripts/design-tokens.mjs --write`, then the check, then the test.

`DEFAULT_ACCENT`, the Appearance picker, the CSS defaults, `primary`/`accent`/`brand`, the run and board tones and the meta theme colour all follow. The one remaining duplicate is the boot script's legacy-migration default in `app/layout.tsx` (see Leftovers).

## Validation

| Check | Result |
|---|---|
| `pnpm typecheck` | 10/10 tasks pass. `desktop-ui:typecheck` executed; 9 were turbo cache hits. |
| `pnpm lint` | Pass: biome, 192 files, no diagnostics (scope unchanged: API/MCP/sidecar files). On the new token files (informational): 13 files, 0 diagnostics. |
| `pnpm --filter @openlinear/desktop-ui test` | Vitest **51 files passed, 3 skipped; 811 tests passed, 8 skipped**. Baseline on this base: 50 + 2 files; 795 + 2 tests. Added: `tokens.test.ts` (+16 tests) and the opt-in screenshot harness (+1 skipped file, +6 skipped tests). Fonts: "ok desktop font fallback config". Scroll gate: 3/3 passes, p95 16.7 ms, max 16.8 ms, 0 long tasks. |
| `node scripts/design-tokens.mjs` | Block in sync; 417/417 pairs; 792/792 preset checks. |
| `pnpm --filter @openlinear/desktop-ui build` | Pass: 20/20 static pages. The built CSS carries the token block and the solid/brand utilities. `next-env.d.ts` was rewritten by the build and restored by hand. |
| Strict TS | No `any`, `@ts-ignore` or `@ts-expect-error`. Type guards instead of casts in `lib/design`. |

## Leftovers

1. **`app/` pages (outside this ownership):**
   - 65 Tailwind palette classes (my-issues, archived, projects/issues, inbox, usage, teams).
   - 9 error pages use `text-muted-foreground/70`: about 3.4:1 now, 2.0:1 before. Drop the `/70`.

   The accent and destructive fills and the destructive text in `app/` are already fixed by the background mapping.
2. **Boot script (`app/layout.tsx`, not mine):**
   - The legacy-blue migration default is still `hover:"#059669"` (3.77:1 with white). It should be `DEFAULT_ACCENT.solid` (`#03855b`); interpolating `lib/design/accent` into the script string would make it one place.
   - Stored preferences saved before this change keep their old solid until re-picked. Green `#16a34a` is 3.30:1, Orange `#ea580c` 3.56:1, Teal `#0d9488` 3.74:1, Yellow `#ca8a04` 2.94:1, Emerald `#059669` 3.77:1, Pink `#db2777` 4.60:1. A small map from old preset hover to new solid in the boot script would migrate them.
   - Stored Purple/Pink/Red brand values (`#8b5cf6` / `#ec4899` / `#ef4444`) still apply, but the picker no longer marks them selected.
3. **Translucent overlays:** 28 `bg-white/[0.0N]`, `border-white/N` and `bg-black/N` classes (18 in `components/`) need an alpha state-layer token design.
4. **No light theme exists.** The architecture is ready: redefine tier 2 under `.light` and re-run `evaluatePairs` with a light resolver.
5. **R5 items deliberately not done:**
   - cool neutrals (hue 256) and the `#386be2` accent, pending owner ratification;
   - fixing the inverted surface ladder;
   - the radius scale and type-size tokens;
   - a lint ban on tertiary text below 14 px;
   - the Tailwind 4 migration and runtime OKLCH.
6. **The screenshot harness is static** (jsdom DOM in Chrome, no live layout). The TanStack migration may move the hook modules it mocks; it is opt-in and doesn't affect the suite.

## Merge hazards

- **`app/globals.css`:**
  - the hand-written `:root` colour block is replaced by the generated block between `@design-tokens` markers (`--radius` kept separately);
  - the `html` background and scrollbars read tokens.

  Never hand-edit inside the markers: change `lib/design` and run `--write`. The test fails on drift.
- **`tailwind.config.ts`:**
  - `colors` rewritten to `token()`;
  - new `backgroundColor` (`destructive`, `linear.accent{,-hover}`) and `opacity.disabled`.

  Anyone adding colours must use `token()` with a variable that exists; the test checks it.
- **`components/ui/*.tsx` (10 files):**
  - `disabled:opacity-50` → `disabled:opacity-disabled`;
  - button and badge `default` → `bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-pressed`;
  - destructive hover/pressed → `-hover` / `-pressed`;
  - checkbox `border-border` → `border-input`;
  - slider track `bg-secondary` → `bg-input`.

  Ring classes are untouched (`focus-ring.test` passes).
- **`lib/design-tokens.ts`:** the `STATUS_COLORS`, `PRIORITY_COLORS` and `BATCH_STATUS_COLORS` class strings were rewritten. Keys and types are unchanged.
- **`components/execution/tokens.ts`:** rewritten onto `run-*` tokens. It imports `@/lib/design/tokens`, and the exports are unchanged. `hover:bg-run-warning/20` (run-controls) and `bg-run-danger/70` (timeline-row) changed.
- **`components/settings/appearance-section.tsx`:**
  - presets come from `@/lib/design/accent` (`preset.solid` is passed as the stored `hover`);
  - the swatch check is `text-background`.

  The picker logic is unchanged.
- **Class-only edits in 31 more component files** (board, chat, desktop, onboarding, projects, quick-capture, settings, task-detail-view, task-form, …). Anyone restyling the same lines will conflict.
- **New test guards:**
  - any new `bg-[#…]`, `border-[#…]` or `text-[#…]` in `app/` or `components/` fails `tokens.test.ts`, so a parallel branch that adds one fails after merge;
  - an edit to `palette.ts` without `PRIMITIVE_HEX` fails;
  - an unused primitive fails.
- **New files:**
  - `apps/desktop-ui/lib/design/{color,palette,tokens,accent,contrast,css,index}.ts`, `tokens.test.ts`, `token-screenshots.capture.test.mjs`, `token-specimen.capture.mjs`;
  - `apps/desktop-ui/scripts/design-tokens.mjs`;
  - `apps/desktop-ui/docs/design-tokens.md`;
  - the 10 `tokens-*.png` files.

  `package.json` is unchanged; the script is run with `node scripts/design-tokens.mjs`.
