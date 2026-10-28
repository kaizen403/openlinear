"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"
import { tokenHex } from "@/lib/design/tokens"

// The browser chrome colour is the canvas token. There is one (dark) theme
// today, so both branches use it; a light theme adds its own canvas token.
const CANVAS = tokenHex("background")

export function ThemeMeta() {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      meta.setAttribute(
        "content",
        resolvedTheme === "light" ? CANVAS : CANVAS,
      )
    }
  }, [resolvedTheme])

  return null
}
