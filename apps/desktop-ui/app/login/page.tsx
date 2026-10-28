"use client"

import { CheckCircle2, Github, KeyRound, Loader2 } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import {
  completeTwoFactorLogin,
  DesktopLoginError,
  fetchAuthProviders,
  GITHUB_OAUTH_UNAVAILABLE_MESSAGE,
  NetworkError,
  parseDesktopCallbackUrl,
  startLogin,
} from "@/lib/api"
import { isDesktopRuntime } from "@/lib/api/runtime"
import { useAuth } from "@/hooks/use-auth"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { toast } from "sonner"

export default function LoginPage() {
  const router = useRouter()
  const {
    isAuthenticated,
    isLoading: isAuthLoading,
    refreshUser,
    completeDesktopCallback,
    pendingTwoFactorToken,
    clearPendingTwoFactor,
  } = useAuth()
  const [githubEnabled, setGithubEnabled] = useState<boolean | null>(null)
  const [isDesktop, setIsDesktop] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [awaitingBrowser, setAwaitingBrowser] = useState(false)
  const [showCallbackFallback, setShowCallbackFallback] = useState(false)
  const [callbackUrl, setCallbackUrl] = useState("")
  const [isCompletingCallback, setIsCompletingCallback] = useState(false)
  const [twoFactorCode, setTwoFactorCode] = useState("")
  const [isVerifyingTwoFactor, setIsVerifyingTwoFactor] = useState(false)
  const [authSuccessMessage, setAuthSuccessMessage] = useState("")

  useEffect(() => {
    setIsDesktop(isDesktopRuntime())
    let cancelled = false
    void fetchAuthProviders().then((providers) => {
      if (!cancelled) setGithubEnabled(providers.github.enabled)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isAuthLoading && isAuthenticated && !authSuccessMessage) {
      router.replace("/")
    }
  }, [authSuccessMessage, isAuthLoading, isAuthenticated, router])

  const finishSignIn = async () => {
    setAuthSuccessMessage("Authenticated. Opening OpenLinear...")
    toast.success("Authenticated. Opening OpenLinear...")
    await new Promise((resolve) => window.setTimeout(resolve, 900))
    router.replace("/")
  }

  const handleGitHubSignIn = async () => {
    setIsStarting(true)
    try {
      const started = await startLogin()
      if (!started) {
        setGithubEnabled(false)
        toast.error(GITHUB_OAUTH_UNAVAILABLE_MESSAGE)
        return
      }
      if (isDesktopRuntime()) setAwaitingBrowser(true)
    } catch (err) {
      console.warn("[Auth] Could not start GitHub sign-in:", err)
      toast.error(
        err instanceof NetworkError
          ? "Could not reach OpenLinear. Check your connection and try again."
          : "Could not start GitHub sign-in. Try again.",
      )
    } finally {
      setIsStarting(false)
    }
  }

  const handleCallbackPaste = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    // Only an openlinear://callback link for a sign-in this app started is
    // accepted; nothing is stored unless the server redeems it.
    const callback = parseDesktopCallbackUrl(callbackUrl)
    if (!callback) {
      toast.error("Paste the openlinear://callback link from your browser.")
      return
    }

    setIsCompletingCallback(true)
    try {
      const result = await completeDesktopCallback(callback)
      if (result.status === "two_factor_required") {
        toast.info("Enter your two-factor code to finish signing in.")
        return
      }
      await finishSignIn()
    } catch (err) {
      setAuthSuccessMessage("")
      toast.error(
        err instanceof DesktopLoginError
          ? err.message
          : "That sign-in link was not accepted. Try signing in again.",
      )
    } finally {
      setIsCompletingCallback(false)
    }
  }

  const handleTwoFactor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!pendingTwoFactorToken || !twoFactorCode.trim()) return
    setIsVerifyingTwoFactor(true)
    try {
      await completeTwoFactorLogin(pendingTwoFactorToken, twoFactorCode.trim())
      clearPendingTwoFactor()
      await refreshUser()
      await finishSignIn()
    } catch {
      // The server spends the temporary token on the first attempt.
      clearPendingTwoFactor()
      setTwoFactorCode("")
      toast.error("That code was not accepted. Sign in again.")
    } finally {
      setIsVerifyingTwoFactor(false)
    }
  }

  return (
    <div className="min-h-screen bg-linear-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/brand/logo.png" alt="OpenLinear" className="h-16 mx-auto mb-4" />
          <p className="text-sm text-linear-text-secondary">Sign in to continue</p>
        </div>

        <div className="bg-linear-bg-secondary border border-linear-border rounded-sm p-6">
          {pendingTwoFactorToken ? (
            <form onSubmit={handleTwoFactor} className="space-y-3">
              <p className="text-sm text-linear-text-secondary text-center">
                Enter the code from your authenticator app, or a backup code.
              </p>
              <input
                value={twoFactorCode}
                onChange={(event) => setTwoFactorCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="Two-factor code"
                className="w-full rounded-sm border border-linear-border bg-linear-bg px-3 py-2 text-sm text-linear-text focus:outline-none focus:border-linear-border-hover font-mono"
              />
              <Button
                type="submit"
                disabled={isVerifyingTwoFactor || !twoFactorCode.trim()}
                className="w-full bg-linear-accent hover:bg-linear-accent-hover text-white"
              >
                {isVerifyingTwoFactor ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                Verify
              </Button>
            </form>
          ) : (
            <>
              {githubEnabled === false && (
                <p className="text-sm text-linear-text-secondary text-center mb-4">
                  GitHub sign-in is disabled. Existing sessions still work until they expire.
                </p>
              )}

              <Button
                onClick={() => void handleGitHubSignIn()}
                disabled={githubEnabled !== true || isStarting}
                className="w-full text-white disabled:opacity-60"
                style={{ backgroundColor: BRAND_COLORS.githubBg }}
              >
                {isStarting ? (
                  <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                ) : (
                  <Github className="w-5 h-5 mr-2" />
                )}
                Sign in with GitHub
              </Button>

              {awaitingBrowser && (
                <p className="mt-3 text-xs text-linear-text-tertiary text-center" role="status" aria-live="polite">
                  Continue in your browser. OpenLinear finishes signing in when GitHub sends you back.
                </p>
              )}
            </>
          )}

          {authSuccessMessage && (
            <div
              className="mt-4 flex items-center gap-2 rounded-sm border border-success/30 bg-success/10 px-3 py-2 text-sm text-success"
              role="status"
              aria-live="polite"
            >
              <CheckCircle2 className="h-4 w-4 flex-none" />
              <span>{authSuccessMessage}</span>
            </div>
          )}

          {isDesktop && !pendingTwoFactorToken && (
            <div className="mt-4 border-t border-linear-border pt-4">
              <button
                type="button"
                onClick={() => setShowCallbackFallback((value) => !value)}
                className="mx-auto flex items-center gap-2 text-sm text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
              >
                <KeyRound className="w-4 h-4" />
                Trouble signing in?
              </button>

              {showCallbackFallback && (
                <form onSubmit={handleCallbackPaste} className="mt-3 space-y-3">
                  <p className="text-xs text-linear-text-tertiary">
                    Use this only if your browser did not hand the sign-in back to OpenLinear. It works
                    for a sign-in started from this window in the last few minutes.
                  </p>
                  <textarea
                    value={callbackUrl}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                    placeholder="Paste openlinear://callback URL"
                    className="min-h-24 w-full resize-y rounded-sm border border-linear-border bg-linear-bg px-3 py-2 text-xs text-linear-text placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover font-mono"
                  />
                  <Button
                    type="submit"
                    disabled={isCompletingCallback || Boolean(authSuccessMessage) || !callbackUrl.trim()}
                    className="w-full bg-linear-accent hover:bg-linear-accent-hover text-white"
                  >
                    {isCompletingCallback ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Signing in...
                      </>
                    ) : (
                      "Continue"
                    )}
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>

        <p className="text-center text-xs text-linear-text-tertiary mt-6">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  )
}
