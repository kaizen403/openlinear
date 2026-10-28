# Design tokens (desktop UI)

Every colour in `apps/desktop-ui` comes from one token set with three tiers. It is authored in TypeScript, emitted as CSS variables, mapped into Tailwind, and checked against WCAG contrast on every test run.

| File | What it holds |
|---|---|
| `lib/design/palette.ts` | **Tier 1, primitives.** OKLCH values, named `<hue>-<L>` (L = OKLCH lightness × 100). |
| `lib/design/tokens.ts` | **Tier 2, semantic** (`surface-*`, `fg-*`, `border-*`, `accent-*`, `tone-*`). **Tier 3, component/role** (shadcn names, legacy `linear-*`, `status-*`, `priority-*`, `run-*`, scrollbar). **State numbers** (hover / pressed / disabled). |
| `lib/design/accent.ts` | Accent picker presets and the default accent. |
| `lib/design/accent-migration.ts` | Maps saved accent choices (pre-token presets, retired blues) to the contrast-safe presets; generates the accent part of the boot script in `app/layout.tsx`. |
| `lib/design/contrast.ts` | Every colour pair the UI promises, and its WCAG minimum. |
| `lib/design/css.ts` | Renders the CSS block. |
| `app/globals.css` | The generated block, between the `@design-tokens:start` / `:end` markers. |
| `tailwind.config.ts` | Maps Tailwind colour names to the variables. |
| `scripts/design-tokens.mjs` | Writes the CSS block, prints the contrast report and the hard-coded colour inventory. |
| `lib/design/tokens.test.ts` | The contract. It fails on drift, on a contrast regression, or on a hard-coded hex class. |

```sh
node scripts/design-tokens.mjs              # check: block in sync, all pairs pass (exit 1 if not)
node scripts/design-tokens.mjs --write      # regenerate the block in app/globals.css
node scripts/design-tokens.mjs --report     # markdown contrast report (before → after, worst pairs, presets)
node scripts/design-tokens.mjs --inventory  # count hard-coded colours in app/, components/, lib/
node scripts/design-tokens.mjs --suggest '#3b82f6'   # solid + text-safe variants of an accent
pnpm --filter @openlinear/desktop-ui exec vitest run lib/design   # the unit test
```

Run all commands from `apps/desktop-ui`. The script transpiles `lib/design/*.ts` with the package's own `typescript`, so it needs no TS runner.

## The tiers

```
--ol-emerald-70: 16 185 129;            tier 1  primitive (sRGB channels, OKLCH in a comment)
--linear-accent-rgb: var(--ol-emerald-70);       runtime input (the accent picker overrides it)
--accent-brand: var(--linear-accent-rgb);        tier 2  semantic
--brand: var(--accent-brand);                    tier 3  component / role
bg-brand  →  background-color: rgb(var(--brand) / 1)    Tailwind
```

Rules:

- Tier 2 references only primitives or a runtime input. Tier 3 references only tier 2.
- Components use Tailwind classes, never a `--ol-*` variable, a hex class (`bg-[#1a1a1a]`), a raw palette class (`text-red-400`), a raw white/black overlay (`bg-white/[0.04]`) or a thinned text token (`text-muted-foreground/70`, which drops below 4.5:1). The test enforces this for `app/` and `components/` (overlays: except the execution kit, see Known deviations).
- Each colour variable is an sRGB channel triplet (`R G B`), so opacity modifiers work: `bg-brand/10`, `border-success/30`.

### Tailwind names

| Use | Classes |
|---|---|
| Surfaces | `bg-background` (canvas), `bg-linear-bg` (app), `bg-linear-bg-secondary` (raised), `bg-linear-bg-tertiary` (inset), `bg-card`, `bg-popover`, and `bg-surface-{canvas,app,raised,inset,card,overlay,hover,pressed}` for new code |
| Text | `text-linear-text` / `text-foreground` (primary), `text-linear-text-secondary`, `text-linear-text-tertiary` = `text-muted-foreground` (tertiary; placeholders too) |
| Borders | `border-border` (subtle separators), `border-linear-border` (cards), `border-linear-border-hover`, `border-input` (control boundaries, ≥ 3:1), `ring-ring` (focus) |
| Brand accent | `text-linear-accent` / `text-brand`, `border-brand`, `ring-linear-accent`, tints `bg-brand/10` |
| Fills that carry text | `bg-primary text-primary-foreground`, `bg-accent text-accent-foreground` (menu highlight), `bg-destructive text-destructive-foreground` |
| Tones | `text-success`, `text-warning`, `text-danger` (= `text-destructive`), `text-info`, `text-discovery`. Tint them as `bg-<tone>/10 border-<tone>/30` |
| Board status / priority | `text-status-{todo,in-progress,done,cancelled,error,committing,publishing}`, `text-priority-{low,medium,high,urgent}` (use the maps in `lib/design-tokens.ts`) |
| Agent-run phases | `text-run-{neutral,info,active,warning,success,danger}` (use `components/execution/tokens.ts`) |

**Fills versus text.** For two legacy names the background differs from the text/border colour:

| Name | As a background | As text / border |
|---|---|---|
| `linear-accent` | the solid accent (`--brand-solid`, `#03855b`) | the brand accent (`#10b981`) |
| `destructive` | the solid red (`#d31212`) | the text-safe red (`#f87171`) |

This mirrors their use: 39 `bg-linear-accent … text-white` buttons and 6 `bg-destructive` buttons, against roughly 100 text and border uses. The override lives in `tailwind.config.ts` `backgroundColor`. With it, every legacy call site, including the `app/` pages, gets a contrast-safe fill without a class change.

### States

| State | How | Token |
|---|---|---|
| Hover on a solid fill | `hover:bg-primary-hover`, `hover:bg-destructive-hover`, legacy `hover:bg-linear-accent-hover` | `--state-hover: 0.9` (the solid at 90 % over the surface) |
| Pressed | `active:bg-primary-pressed`, `active:bg-destructive-pressed` | `--state-pressed: 0.8` |
| Hover on a row / quiet button | `hover:bg-surface-hover` (`#1a1a1a`); pressed `bg-surface-pressed` (`#1f1f1f`) | `surface-hover`, `surface-pressed` |
| Translucent row states (any surface) | `hover:bg-layer-hover`, `bg-layer-faint` (unread row, sticky group header), `divide-layer-divider`, `border-layer-outline` (chip outline) | `state-layer` at `--state-layer-{hover,faint,divider,outline}` (0.04, 0.02, 0.04, 0.10) |
| Modal / drawer backdrop | `bg-scrim/40` … `bg-scrim/80` | `scrim` |
| Selected | `bg-brand/10 border-brand` | the selected-row contrast pairs |
| Disabled | `disabled:opacity-disabled` | `--state-disabled: 0.5` (exempt from WCAG 1.4.3) |
| Focus | `focusRing` / `focusRingInset` from `components/ui/focus-ring.ts` (`ring-ring`, `#e6e6e6`, ≥ 13.9:1) | `ring` |
| Destructive / warning / success / info | `text-destructive`, `text-warning`, `text-success`, `text-info`, plus `/10` and `/30` tints | `tone-*` |

Hover and pressed are alphas, not separate colours. A solid at 90 % or 80 % over the dark surfaces reads darker and only raises the contrast of its white text. Because they derive from the solid at runtime, they stay correct for every accent preset.

## The contrast rule

`lib/design/contrast.ts` lists every pair: about 430 of them. Each is checked with the WCAG 2.x formula, compositing translucent layers over the surface they sit on.

- **Text: 4.5:1.** This covers every text and icon token on every surface: canvas, popover, card, inset, app, raised, hover and pressed. It also covers each coloured token on its own 10 % and 20 % tint, the text ladder on a selected (brand 10 %) row, the text ladder and coloured tokens on a state-layer row (`layer-faint`, `layer-hover`), and white on every solid at rest, hover and pressed. The UI's text is 10–14 px, so the large-text 3:1 exception never applies.
- **UI components: 3:1** (WCAG 1.4.11). Covered: control boundaries (`input`: inputs, selects, textareas, checkboxes, switch and slider tracks), the focus ring, brand indicators, the solid accent used as a checked fill, the switch thumb on its track, and the slider range on its track.
- **Decorative: reported, not enforced.** Separators, card outlines and the scrollbar thumb don't identify a component on their own, so WCAG 1.4.11 doesn't apply. They stay subtle (1.1–1.7:1).
- **Accent presets.** Every accent-dependent pair is re-run for each picker preset (`evaluateAccentPresets`), so a preset can't reintroduce a failure.

The unit test fails when any enforced pair drops below its minimum, and it prints the offending pairs. It also proves its own reach: with the base tree's colours (emerald + white, `#6a6a6a`, `#595959`, `#1f1f1f` inputs) it must report at least 50 failures.

## How to add a token

1. **Need a new colour?** Add a primitive to `palette.ts` in OKLCH. Name it `<hue>-<L>`, and add its hex to `PRIMITIVE_HEX`. The test checks the round-trip, the sRGB gamut and the name. Use an existing primitive if one is close: the test rejects unused primitives.
2. **Give it a meaning** in `SEMANTIC` (tier 2), for example `"tone-attention": "orange-75"`.
3. **If components need a role name**, add it to `COMPONENT` (tier 3), for example `"status-blocked": "tone-danger"`.
4. **Expose it to Tailwind** in `tailwind.config.ts` with `token("<name>")`. The test checks that every name exists.
5. **Add its pairs** to `contrast.ts`. A text token belongs in `TINTED_TEXT` if it is drawn on its own tint. A control boundary belongs in the UI pairs.
6. Run `node scripts/design-tokens.mjs --write`, then `node scripts/design-tokens.mjs`, then the unit test.

Class names must be written out in full in source (`"text-status-done"`, not `` `text-${x}` ``) so Tailwind can see them.

## How to change the accent in one place

The default accent is two primitives in `lib/design/palette.ts`:

- `emerald-70` is the brand colour (indicators, accent text, borders, tints).
- `emerald-55` is the solid: the same hue with the lightness lowered until white text clears 4.5:1.

To move to another hue (for example the plan's proposed `#386be2`, which the owner has not ratified):

1. Run `node scripts/design-tokens.mjs --suggest '#386be2'`. It prints the solid and, if needed, a lighter text-safe brand.
2. Replace the two primitives in `palette.ts` (and their `PRIMITIVE_HEX`). Rename them by their new L, and point `RUNTIME_INPUTS` in `tokens.ts` at the new names.
3. Run `node scripts/design-tokens.mjs --write`, then the check and the test. `DEFAULT_ACCENT` (`accent.ts`) derives from the primitives, so the Appearance picker follows.
4. Nothing else: the boot script in `app/layout.tsx` is generated from `lib/design/accent-migration.ts`, which reads the presets.

### Saved accent choices

The picker stores `{ accent, hover }` (`hover` is the solid) in `localStorage["openlinear-accent"]`. `ACCENT_MIGRATION_TABLE` maps every hex a picker ever saved — the current presets, the pre-token presets (Emerald `#059669`, Green `#16a34a`, … whose solids failed 4.5:1) and the retired blues — to the current preset. The pre-paint boot script (`accentBootScript()`) and the Appearance section (`migrateStoredAccent`) both apply it and write the migrated value back, so an old choice is fixed on the first load. When you add or change a preset, keep its old values in `LEGACY_PRESET_VALUES`; `accent-migration.test.ts` runs the inlined script against the TypeScript function and checks every target solid.

The runtime picker writes `--linear-accent`, `--linear-accent-rgb` (brand) and `--linear-accent-hover`, `--linear-accent-hover-rgb` (solid; the name is legacy) on `<html>`. Everything else derives from those, so a preset recolours buttons, menus, focus-adjacent accents, run pills and board chips together.

## Why sRGB channels at runtime (and where OKLCH lives)

Primitives are authored in OKLCH: perceptual lightness makes "same hue, darker" a single-number change. The CSS ships sRGB channels. The reasons:

- **The webviews.** Tauri's macOS floor is 10.15 (`tauri.conf.json`). WKWebView is the system WebKit, which gained `oklch()` with Safari 15.4 (2022), so a 10.15/11 machine that never took a Safari update can't parse it. WebKitGTK and older Chromium-based WebView2 builds have similar floors.
- **No per-declaration fallback.** With CSS variables a colour like `oklch(var(--x) / 0.1)` is only validated at computed-value time. A browser without `oklch()` doesn't fall back to an earlier `rgb()` declaration: the property becomes `unset` (transparent backgrounds, inherited text). The only real fallback is an `@supports` block that switches the colour function in every utility, which means a second copy of every colour class in Tailwind 3.4. Tailwind 3's `<alpha-value>` needs a single function per colour.
- **No visual gain.** Every token sits inside sRGB (test-enforced), so `oklch()` and `rgb()` paint identical pixels.

**Path forward.** On Tailwind 4 (which emits `oklch()` and `color-mix()` natively), or once the floor reaches Safari 16.4 / WebKitGTK 2.40, change `toChannels` in `css.ts` and the `token()` helper in `tailwind.config.ts`. Those two places are the whole switch.

## Known deviations

- **Inverted surface ladder.** `linear-bg-tertiary` (`#0f0f0f`) is darker than `linear-bg` (`#111111`) although it is used for "raised" pills. The values are kept for visual identity; fixing it means redesigning the surface ladder.
- **Translucent overlays in the execution kit.** `app/` and the other components use `layer-*` and `scrim`; 13 `bg-white/…`, `border-white/…`, `bg-black/30` and `decoration-white/30` classes remain in `components/execution/` (owned by the run-kit work). Mapping: `bg-white/[0.04]`, `bg-white/[0.06]` → `bg-layer-hover`; `bg-white/10`, `border-white/10`, `border-white/15`, `bg-white/15` → `layer-outline`; `bg-black/30` → `bg-scrim/30`. The token test allows them only under `components/execution/`.
- **Dark theme only.** "Light" is disabled in Appearance. A light theme redefines tier 2 under `.light` (tier 1 and tier 3 stay), and `evaluatePairs(pairs, resolver)` is re-run with a light resolver.
- **Decorative borders** stay below 3:1 on purpose (see the contrast rule).
