"use client"

import { useEffect, useRef, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Loader2, AlertCircle } from "lucide-react"
import { verifyCallbackToken } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"

/**
 * The ONLY route that adopts a `?token=` query param into the session.
 *
 * Previously `AuthProvider` (hooks/use-auth.tsx) read `?token=` on every
 * route, app-wide, and silently swapped the session whenever it was present
 * — a link like `https://app/anything?token=<attacker-jwt>` would log the
 * victim into the attacker's account with no confirmation. This route is the
 * deliberate, explicit replacement: it verifies the token against the API
 * (via `verifyCallbackToken`, which round-trips to `/api/auth/me`) before
 * adopting it, and it's the only place in the app that does so.
 *
 * The web GitHub OAuth flow's success redirect must point here (with
 * `?token=`) for this to work end to end — see the note in
 * lib/api/auth.ts / the T5 writeup for the exact API-side redirect target.
 * Desktop login is unaffected: it never puts the token in the window URL —
 * it arrives via a `openlinear://callback` deep link handled over Tauri IPC
 * (see the `auth:callback` listener in hooks/use-auth.tsx).
 */
export function SessionCallbackClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { refreshUser } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    const token = searchParams.get("token")
    const authError = searchParams.get("error")

    if (authError) {
      console.error("[Auth] Session callback error:", authError)
      router.replace("/login")
      return
    }

    if (!token) {
      router.replace("/login")
      return
    }

    void (async () => {
      try {
        await verifyCallbackToken(token)
        await refreshUser()
        router.replace("/")
      } catch (err) {
        console.warn("[Auth] Failed to verify session callback token:", err)
        setError("That sign-in link is no longer valid. Please sign in again.")
        window.setTimeout(() => router.replace("/login"), 1800)
      }
    })()
  }, [searchParams, router, refreshUser])

  return (
    <main className="min-h-screen bg-linear-bg flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-sm border border-linear-border bg-linear-bg-secondary p-6 text-center">
        <img src="/brand/logo.png" alt="OpenLinear" className="h-10 mx-auto mb-4" />
        {error ? (
          <div className="flex flex-col items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-5 w-5" />
            <span>{error}</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-sm text-linear-text-secondary">
            <Loader2 className="h-5 w-5 animate-spin text-linear-accent" />
            <span>Signing you in...</span>
          </div>
        )}
      </div>
    </main>
  )
}
