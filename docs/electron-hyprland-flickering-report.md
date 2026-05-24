# Electron Flickering on Hyprland — Technical Report

**Date:** 2026-05-24
**Platform:** Arch Linux + Hyprland (Wayland compositor)
**App:** OpenLinear Electron desktop wrapper
**Reporter:** kaizen

---

## Problem Summary

The Electron desktop app (`pnpm start:electron`) opens with severe visual flickering on Hyprland. The window appears to rapidly flash/resize during initial load, making the app unusable. This does **not** occur with the Tauri build on the same system, nor with the web app in Chromium.

---

## Environment

- **OS:** Arch Linux
- **WM/Compositor:** Hyprland (Wayland)
- **Electron:** v35.7.5 (system `/usr/bin/electron`)
- **Node:** v24.12.0
- **OpenLinear branch:** `dev`

---

## What Was Tried (Chronological)

### 1. CSS Flexbox Scroll Fix (chat-message-list.tsx)
Added `min-h-0` to the chat message list scroll container. This fixed a WebKitGTK-specific flexbox scroll issue but is **irrelevant** to Electron (Electron uses Chromium, not WebKitGTK).

**Status:** Unrelated to flickering.

---

### 2. Electron Wrapper Creation
Created `apps/desktop-electron/` as a minimal Electron main process wrapping the existing Next.js static export.

**Architecture:**
- Main process: `src/main.ts` — creates BrowserWindow, spawns sidecar, handles IPC
- Preload: `src/preload.ts` — exposes `window.electronAPI` via contextBridge
- Sidecar: `src/sidecar.ts` — spawns `openlinear-sidecar` binary via Node child_process
- Builder: `electron-builder.json` — targets AppImage + deb for Linux

**Frontend patches:** Runtime detection of Electron vs Tauri in:
- `lib/api/client.ts` — sidecar URL resolution
- `lib/api/auth.ts` — desktop login flow
- `hooks/use-auth.tsx` — auth callback listener
- `components/layout/sidebar.tsx` — window controls
- `components/desktop/*.tsx` — native API calls

---

### 3. Initial Flickering Diagnosis — CSS Transitions

**Hypothesis:** The CSS "fast" render profile (disables backdrop-filter, transitions, animations) was only active for Tauri + Linux, not Electron + Linux.

**Fix:** Patched `app/layout.tsx` inline script to detect `window.electronAPI` and apply `data-openlinear-render-profile="fast"` for Electron on Linux.

**Result:** Flickering persisted. The CSS transitions were already disabled, but the window itself was still flashing.

---

### 4. Window Creation Timing

**Hypothesis:** `ready-to-show` event fires before the compositor has stabilized, causing a flash of partially-rendered content.

**Fixes tried:**
- `paintWhenInitiallyHidden: false` — prevents painting until explicitly shown
- `show: false` + `did-finish-load` (instead of `ready-to-show`) on Linux
- 250ms `setTimeout` delay before `win.show()`
- `backgroundColor: "#0a0a0a"` — prevents white flash

**Result:** Flickering persisted. The window shows but flashes during the first few seconds.

---

### 5. Hardware Acceleration & GPU

**Hypothesis:** GPU compositor conflicts with Hyprland's Wayland compositor.

**Fixes tried:**
- `app.disableHardwareAcceleration()` — disabled GPU compositing entirely
- `app.commandLine.appendSwitch("disable-gpu-vsync")`
- `app.commandLine.appendSwitch("disable-software-rasterizer")`
- `app.commandLine.appendSwitch("ozone-platform", "x11")` — force XWayland
- `app.commandLine.appendSwitch("ozone-platform-hint", "x11")`
- `process.env.ELECTRON_OZONE_PLATFORM_HINT = "x11"`

**Result:** Window went **completely blank** with error:
```
[ERROR:ui/base/x/x11_software_bitmap_presenter.cc:147] XGetWindowAttributes failed for window 1
```

This indicates `disableHardwareAcceleration()` + XWayland force causes Chromium's software bitmap presenter to fail on Hyprland.

---

### 6. Window Properties

**Fixes tried:**
- `transparent: false` — disables alpha blending
- `hasShadow: false` — disables drop shadow
- `frame: true` — native window frame instead of custom
- `titleBarStyle: "default"` — standard title bar

**Result:** No improvement. Flickering persisted.

---

### 7. Positioning (Latest Attempt)

**Hypothesis:** `center: true` in BrowserWindow options causes Electron to create the window at (0,0) then reposition it to center. Hyprland animates this reposition with a slide effect, causing flicker.

**Fix:** Removed `center: true`. Calculated center position explicitly using `screen.getPrimaryDisplay().workAreaSize` and passed `x`/`y` to BrowserWindow.

**Result:** Flickering persisted.

---

## Current State (As of 2026-05-24 11:30 IST)

The Electron app:
1. ✅ Compiles successfully (`tsc` passes)
2. ✅ Next.js static export builds correctly
3. ✅ Sidecar spawns and reports ready on ephemeral port
4. ✅ Local HTTP server serves frontend files
5. ✅ Window opens at correct position
6. ❌ **Severe flickering during initial 2-3 seconds of window life**
7. ✅ After flickering stops, app appears to function normally

---

## Leading Hypotheses (Unverified)

### Hypothesis A: Hyprland Window Animation Rules
Hyprland applies entrance animations (slide/scale) to all new windows by default. Electron/Chromium's initial window surface may be resizing or repainting rapidly during load, causing Hyprland to restart the entrance animation repeatedly.

**Potential fix:** Add a Hyprland window rule to disable animations for OpenLinear:
```conf
# ~/.config/hypr/hyprland.conf
windowrulev2 = noanim, class:^(OpenLinear)$
windowrulev2 = noborder, class:^(OpenLinear)$
windowrulev2 = noshadow, class:^(OpenLinear)$
```

---

### Hypothesis B: Chromium Ozone/Wayland Backend Issues
Electron 35 on Linux defaults to the Ozone platform abstraction. On Hyprland (a custom wlroots-based compositor), Chromium's Wayland backend may have unpatched bugs with surface commits during initial load.

**Potential fix:** Force native X11 backend (not XWayland) by setting environment variable before launching:
```bash
export ELECTRON_OZONE_PLATFORM_HINT=x11
pnpm start:electron
```
Note: Earlier attempt with `app.commandLine.appendSwitch` failed because it was combined with `disableHardwareAcceleration()`. These should be tested **independently**.

---

### Hypothesis C: Next.js Hydration Mismatch
The static export produces HTML that React then hydrates. During hydration, React may re-render the entire DOM tree, causing layout shifts that Electron/Chromium renders as visible flashes.

**Potential fix:** Add `suppressHydrationWarning` and ensure server/client HTML match exactly. Or disable SSR entirely for the Electron build.

---

### Hypothesis D: EventSource / SSE Connection Racing
The frontend immediately tries to connect to `/api/events` via EventSource. If the sidecar isn't fully ready, rapid connection retries may cause UI updates (loading states) that manifest as flicker.

**Potential fix:** Delay EventSource connection until `sidecar:ready` event is confirmed.

---

## Recommended Next Steps for Investigating Agent

1. **Test Hyprland window rules** — Add `noanim` rule and verify if flickering stops. This is the fastest test.

2. **Test X11 backend without hardware accel disable** — Set `ELECTRON_OZONE_PLATFORM_HINT=x11` as an **environment variable** before launch (not via `appendSwitch`), and do NOT call `app.disableHardwareAcceleration()`. Test if this produces a stable window.

3. **Profile with `WAYLAND_DEBUG=1`** — Run with Wayland protocol debugging to see if there are excessive `wl_surface_commit` calls during flickering.

4. **Check `hyprctl clients` output** — Verify whether the Electron window is running under native Wayland or XWayland.

5. **Test with a minimal HTML file** — Create a minimal `BrowserWindow` loading `about:blank` or a simple static HTML file. If this also flickers, it's an Electron/Hyprland issue, not an OpenLinear app issue.

6. **Try `new BrowserWindow({ show: true })`** — Remove `show: false` entirely and let the window appear immediately. The `ready-to-show` pattern may be interacting poorly with Hyprland's animation system.

7. **Consider Tauri as primary Linux target** — If Electron cannot be made stable on Hyprland, the Tauri build (with the CSS scroll fixes already applied) may be the more pragmatic Linux choice despite WebKitGTK's limitations. The web app at openlinear.tech already works perfectly in Chromium.

---

## Files Involved

- `apps/desktop-electron/src/main.ts` — Main process, window creation
- `apps/desktop-electron/src/preload.ts` — IPC bridge
- `apps/desktop-electron/src/sidecar.ts` — Sidecar spawning
- `apps/desktop-ui/app/layout.tsx` — CSS render profile detection
- `apps/desktop-ui/app/globals.css` — Fast render profile CSS (disables transitions/animations)

---

## Build Commands

```bash
# Development (loads from localhost:3000, no static build needed)
pnpm dev:electron

# Production-like (builds static export + launches Electron)
pnpm start:electron

# Build distributable
pnpm build:electron:linux   # AppImage + deb
```

---

## Notes

- The Tauri desktop app (`pnpm --filter @openlinear/desktop tauri dev`) works without flickering on the same Hyprland setup, confirming this is Electron-specific.
- The web app at `https://openlinear.tech` works perfectly in Chromium on the same system.
- This strongly suggests the issue is in the **Electron ↔ Hyprland interaction**, not the OpenLinear frontend code itself.
