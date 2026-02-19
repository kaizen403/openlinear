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
  const [copied, setCopied] = useState(false)

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

    const timeout = window.setTimeout(() => {
      window.close()
    }, 350)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [code])

  const copyCallbackUrl = async () => {
    if (!callbackUrl) return
    try {
      await navigator.clipboard.writeText(callbackUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <main className="min-h-screen bg-linear-bg flex items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-lg border border-linear-border bg-linear-bg-secondary p-6 space-y-4">
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
            Callback data has been sent to the app. This tab should close automatically.
          </p>
        ) : (
          <p className="text-sm text-linear-text-secondary">
            No authorization code was found. Copy this URL and paste it in AI Providers settings.
          </p>
        )}

        <div className="rounded-md border border-linear-border bg-linear-bg p-3 text-xs text-linear-text-tertiary break-all">
          {callbackUrl || "Loading callback URL..."}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={copyCallbackUrl}
            className="border-linear-border text-linear-text-secondary"
          >
            <Copy className="w-3.5 h-3.5 mr-2" />
            {copied ? "Copied" : "Copy callback URL"}
          </Button>
          <Link
            href="/settings?section=ai-providers"
            className="inline-flex h-9 items-center rounded-md bg-linear-accent px-3 text-sm font-medium text-white hover:bg-linear-accent-hover"
          >
            Back to AI Providers
          </Link>
        </div>
      </div>
    </main>
  )
}
