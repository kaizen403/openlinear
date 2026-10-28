/**
 * Save data as a file through a blob link (browsers and the desktop webview).
 * Returns false when the environment can't create one (no DOM).
 */
export function downloadJson(fileName: string, data: unknown): boolean {
  if (typeof document === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return false
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement("a")
    link.href = url
    link.download = fileName
    link.rel = "noopener"
    document.body.appendChild(link)
    link.click()
    link.remove()
    return true
  } finally {
    // Let the click start the download before the URL goes away.
    setTimeout(() => URL.revokeObjectURL(url), 1_000)
  }
}

/** `filename="…"` from a Content-Disposition header, if present and safe. */
export function fileNameFromDisposition(header: string | null, fallback: string): string {
  const match = header ? /filename="([^"/\\]{1,200})"/.exec(header) : null
  return match?.[1] ?? fallback
}
