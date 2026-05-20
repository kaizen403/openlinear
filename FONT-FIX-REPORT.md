# Font Rendering Fix Report — OpenLinear Desktop (Linux/Arch)

## Problem

Inconsistent font rendering in the Tauri desktop app on Arch Linux:
- Irregular random gaps between letters (uneven tracking)
- Small/weird letters at different sizes/weights appearing mid-word
- Layout shift after font loads

## Environment

- OS: Arch Linux
- Desktop app: Tauri (uses WebKitGTK 4.1 webview, NOT Chromium)
- Rendering stack: WebKitGTK → Cairo → FreeType → HarfBuzz
- Font: Anthropic Sans Web Text (variable font, woff2, 115KB)
- Font axes: `wght` 300-800 (default 400), `opsz` 16-48 (default 16)

## Root Causes (in order of discovery)

### 1. Variable font axis bugs in WebKitGTK

WebKitGTK has unreliable variable-font support:
- `format('woff2-variations')` inconsistently honored
- `font-variation-settings` for `opsz` axis causes per-glyph interpolation bugs
- Produces uneven tracking and mid-word weight/size jumps

**Fix:** Generated four static per-weight woff2 files using fontTools `instantiateVariableFont`, each pinned at opsz=16 (Text master). Total bundle dropped from 115KB to ~91KB.

### 2. User fontconfig aliases leaking into WebKitGTK

User's `~/.config/fontconfig/fonts.conf` had strong-binding aliases:
```xml
<match target="pattern">
  <test qual="any" name="family"><string>Inter</string></test>
  <edit name="family" mode="assign" binding="strong"><string>Geist</string></edit>
</match>
<match target="pattern">
  <test qual="any" name="family"><string>system-ui</string></test>
  <edit name="family" mode="assign" binding="strong"><string>Geist</string></edit>
</match>
```

WebKitGTK queries fontconfig for fallback glyphs. Any glyph that fell through to `Inter` or `system-ui` in the CSS fallback chain was silently replaced with Geist (completely different metrics), causing mid-word size/weight jumps.

**Fix:** Removed `Inter`, `Ubuntu`, `Segoe UI`, `system-ui`, `-apple-system`, and generic `sans-serif` from the CSS fallback chain. Final chain: `'Anthropic Sans', 'Cantarell', 'Noto Sans', 'DejaVu Sans'`.

### 3. Tailwind config re-introducing system-ui

`tailwind.config.ts` had:
```ts
fontFamily: {
  sans: ["var(--font-sans)", "system-ui", "sans-serif"],
  ui: ["var(--font-ui)", "system-ui", "sans-serif"],
}
```

Tailwind's `font-sans` utility is applied by Tailwind preflight to `body` and used by virtually every component. This appended `system-ui` to the computed `font-family` on every element, bypassing the cleaned `--font-sans` CSS variable entirely. The fontconfig `system-ui` → `Geist` rewrite then kicked in.

**Fix:** Changed to:
```ts
fontFamily: {
  sans: ["var(--font-sans)"],
  ui: ["var(--font-ui)"],
  mono: ["var(--font-mono)"],
}
```

The CSS variable already contains the full safe fallback chain. Tailwind just needs to reference it without adding its own fallbacks.

### 4. Static WOFF2 files kept variable-font identity metadata (THE FINAL BUG)

The generated per-weight files were static in outline data, but not static in identity metadata:
- all four files still exposed internal names like `Anthropic Sans Web Text Regular`
- all four shared the same unique/PostScript names: `AnthropicSansWebVariable-TextRegular`
- all four kept `nameID 25` (`AnthropicSansWebVariable`)
- all four kept a `STAT` table with `wght`, `opsz`, and `ital` axes
- non-regular weights kept the OS/2 `Regular` selection bit instead of weight-specific selection bits

That means the CSS descriptors said "400/500/600/700", while the font files still told the lower stack "same variable Text Regular face". On WebKitGTK/Cairo/fontconfig this can collide in face registration, fallback matching, or cache selection below CSS and show up as random weight/size changes.

**Fix:** normalized each bundled WOFF2 into a plain static face:
- stripped `STAT` and any variable/axis metadata tables
- set family/subfamily/full/PostScript names to `Anthropic Sans Regular|Medium|SemiBold|Bold`
- set unique IDs to `OpenLinear;AnthropicSans-{Style};static-opsz16-wght{weight}`
- removed variation PostScript prefix `nameID 25`
- corrected OS/2 `usWeightClass`, `fsSelection`, and `head.macStyle`
- updated `scripts/build-static-fonts.sh` so future regenerated fonts get the same cleanup

## Other fixes applied along the way

| Fix | File | What |
|-----|------|------|
| `font-display: block` | globals.css | Prevents FOUT reflow (fallback metrics differ wildly) |
| Dropped `text-rendering: optimizeLegibility` | globals.css | Triggers FreeType slow path, bad with variable fonts |
| Added `font-synthesis: none` | globals.css | Prevents browser from fake-bolding fallback during load |
| Dropped `font-feature-settings: "calt" 0` | globals.css | Was disabling contextual alternates (FreeType honors literally) |
| Added `font-variant-ligatures: contextual` | globals.css | Keeps contextual alternates enabled for proper kerning |
| Added `unicode-range` to @font-face | globals.css | Prevents webkit from querying fontconfig for glyphs the woff2 covers |
| Cache clear in start script | start-prod-preview.sh | `rm -rf .next out` before build so CSS changes always take effect |
| Static metadata normalization | fonts + build-static-fonts.sh | Makes each WOFF2 a distinct non-variable face all the way down |
| Font regression verifier | scripts/verify-desktop-fonts.js | Fails if axis tables, stale variable names, wrong weights, or dangerous active fallbacks return |
| Turbopack root pin | desktop-ui/next.config.js | Keeps CSS/font builds rooted in the repo instead of parent `/home/kaizen` lockfiles |
| Font URL cache busting | globals.css | Forces WebKitGTK to fetch the normalized WOFF2 files instead of reusing stale cache records |
| Tauri dev URL cache busting | start-prod-preview.sh | Prevents the preview webview from reusing an old cached app shell |

## Commits (all on `dev` branch)

1. `323bfb6` — font-display block, opsz pin, cache clear in start script
2. `f47b301` — static per-weight font masters for WebKitGTK
3. `998fa0b` — bypass fontconfig family aliases in globals.css
4. `48a0157` — drop tailwind fontFamily system-ui fallback (final fix)

Current hardening pass after that commit:
- normalized the four committed WOFF2 files
- hardened `scripts/build-static-fonts.sh`
- added `pnpm --filter @openlinear/desktop-ui test` as the font regression check
- pinned the desktop UI Turbopack root to the repo
- cache-busted the font URLs and Tauri preview URL

## Key Lesson

On Linux with WebKitGTK, the font rendering pipeline is:
```
CSS font-family → WebKitGTK → fontconfig pattern matching → FreeType rasterization
```

fontconfig's pattern matching can silently rewrite font names before they reach FreeType. Any font name in the CSS fallback chain that matches a user's fontconfig alias will be substituted with a completely different font, potentially mid-word if the primary font doesn't cover certain glyphs or during the font-load period.

The safe approach for Tauri/WebKitGTK apps:
1. Use static fonts (not variable) to avoid axis interpolation bugs
   - "Static" must include metadata: no `STAT`/axis tables, no variable PostScript prefix, no shared Regular names across weights
2. Keep the CSS fallback chain minimal — only fonts you know aren't commonly aliased, and do not use generic `sans-serif` when user fontconfig aliases it
3. Don't duplicate fallback names in both CSS variables AND Tailwind config
4. Add `unicode-range` to @font-face to prevent unnecessary fontconfig queries
5. Keep an automated font artifact check; visual symptoms appear too late and are too stack-dependent

## Verification

Commands run after the hardening pass:
- `pnpm --filter @openlinear/desktop-ui test`
  - validates all four WOFF2 files have no `STAT`/variable tables
  - validates names, PostScript IDs, OS/2 weights, and selection bits
  - validates active desktop font config does not reintroduce `system-ui`, `Inter`, `Geist`, `Segoe UI`, `Ubuntu`, or `-apple-system`
- `pnpm --filter @openlinear/desktop-ui typecheck`
- `BUILD_FOR_TAURI=1 pnpm --filter @openlinear/desktop-ui build`
- `fc-scan apps/desktop-ui/public/fonts/*.woff2`
  - now reports family `Anthropic Sans`
  - styles `Regular`, `Medium`, `SemiBold`, `Bold`
  - `variable=False` for all four files
