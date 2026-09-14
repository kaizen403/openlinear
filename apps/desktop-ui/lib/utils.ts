import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Schemes safe to hand to the OS shell (Tauri) or a new browser tab (web).
// Callers include markdown-rendered content (components/markdown-view.tsx)
// and PR links built from server data — the href isn't necessarily trusted,
// so anything else (javascript:, file:, custom app schemes, etc.) is rejected
// rather than opened.
const ALLOWED_EXTERNAL_SCHEMES = new Set(["https:", "mailto:"])

export async function openExternal(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    return
  }

  try {
    const { open } = await import("@tauri-apps/plugin-shell")
    await open(parsed.toString())
  } catch {
    // noopener,noreferrer: this may be markdown-supplied content, so the
    // opened page must not get a `window.opener` back to this app.
    window.open(parsed.toString(), "_blank", "noopener,noreferrer")
  }
}
