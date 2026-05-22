"use client"

import { useEffect } from "react"
import { useTheme } from "next-themes"

export function ThemeMeta() {
  const { resolvedTheme } = useTheme()

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) {
      meta.setAttribute(
        "content",
        resolvedTheme === "light" ? "#0a0a0a" : "#0a0a0a",
      )
    }
  }, [resolvedTheme])

  return null
}
