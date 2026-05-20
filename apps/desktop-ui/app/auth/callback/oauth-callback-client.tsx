"use client"

import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useEffect, useState } from "react"
import { AlertCircle, CheckCircle2, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"

const OAUTH_CALLBACK_STORAGE_KEY = "opencode-oauth-callback"
const OAUTH_PENDING_STORAGE_KEY = "opencode-oauth-pending"

export function OAuthCallbackClient() {
  const searchParams = useSearchParams()
  const code = searchParams.get("code")
  const error = searchParams.get("error")
  const [callbackUrl, setCallbackUrl] = useState("")
  const [copyStatus, setCopyStatus] = useState("")

  useEffect(() => {
    if (typeof window === "undefined") return

    const currentUrl = window.location.href
    setCallbackUrl(currentUrl)

    if (!code) return

    let pendingProviderId: string | undefined
    let pendingMethod: number | undefined

    try {
      const pendingRaw = localStorage.getItem(OAUTH_PENDING_STORAGE_KEY)
      if (pendingRaw) {
        const pending = JSON.parse(pendingRaw) as {
          providerId?: string
          method?: number
          timestamp?: number
        }
        const ageMs = pending.timestamp ? Date.now() - pending.timestamp : 0
        if (ageMs <= 10 * 60 * 1000) {
          pendingProviderId = pending.providerId
          if (typeof pending.method === "number") {
            pendingMethod = pending.method
          }
        }
      }
    } catch {}

    localStorage.setItem(
      OAUTH_CALLBACK_STORAGE_KEY,
      JSON.stringify({
        url: currentUrl,
        code,
        providerId: pendingProviderId,
        method: pendingMethod,
        timestamp: Date.now(),
      })
    )

  }, [code])

  const copyText = async (value: string, label: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopyStatus(`${label} copied.`)
      window.setTimeout(() => setCopyStatus(""), 2000)
      return
    } catch {}

    const field = document.createElement("textarea")
    field.value = value
    field.setAttribute("readonly", "")
    field.style.position = "fixed"
    field.style.left = "-9999px"
    document.body.appendChild(field)
    field.select()

    try {
      document.execCommand("copy")
      setCopyStatus(`${label} copied.`)
      window.setTimeout(() => setCopyStatus(""), 2000)
    } catch {
      setCopyStatus("Copy failed. Select the callback URL manually.")
    } finally {
      field.remove()
    }
  }

  return (
    <main className="min-h-screen bg-linear-bg flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-sm border border-linear-border bg-linear-bg-secondary p-6 space-y-4">
        <img src="/brand/logo.png" alt="OpenLinear" className="h-10 mx-auto" />

        <div className="flex items-center gap-2">
          {error ? (
            <AlertCircle className="h-5 w-5 text-red-400" />
          ) : (
            <CheckCircle2 className="h-5 w-5 text-green-400" />
          )}
          <h1 className="text-base font-semibold text-linear-text">
            {error ? "OAuth failed" : "OAuth callback received"}
          </h1>
        </div>

        {error ? (
          <p className="text-sm text-linear-text-secondary">
            Provider returned an error: <span className="text-linear-text">{error}</span>
          </p>
        ) : code ? (
          <p className="text-sm text-linear-text-secondary">
            Callback data is ready. If the app did not finish automatically, paste this URL or code in AI Providers settings.
          </p>
        ) : (
          <p className="text-sm text-linear-text-secondary">
            No authorization code was found. Copy this URL and paste it in AI Providers settings.
          </p>
        )}

        <textarea
          readOnly
          value={callbackUrl || "Loading callback URL..."}
          className="min-h-24 w-full resize-y rounded-sm border border-linear-border bg-linear-bg p-3 font-mono text-xs text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover"
          onFocus={(event) => event.currentTarget.select()}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => copyText(callbackUrl, "Callback URL")}
            className="border-linear-border text-linear-text-secondary"
          >
            <Copy className="w-3.5 h-3.5 mr-2" />
            Copy callback URL
          </Button>
          {code && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => copyText(code, "Code")}
              className="border-linear-border text-linear-text-secondary"
            >
              <Copy className="w-3.5 h-3.5 mr-2" />
              Copy code
            </Button>
          )}
          <Link
            href="/settings?section=ai-providers"
            className="inline-flex h-9 items-center rounded-sm bg-linear-accent px-3 text-sm font-medium text-white hover:bg-linear-accent-hover"
          >
            Back to AI Providers
          </Link>
        </div>
        {copyStatus && (
          <p className="text-xs text-linear-text-tertiary" aria-live="polite">
            {copyStatus}
          </p>
        )}
      </div>
    </main>
  )
}
