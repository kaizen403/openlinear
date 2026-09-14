"use client"

import { CheckCircle2, Github, KeyRound, Loader2 } from "lucide-react"
import { useEffect, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ApiError, NetworkError, extractCallbackToken, verifyCallbackToken } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { toast } from "sonner"

export default function LoginPage() {
  const router = useRouter()
  const { isAuthenticated, isLoading: isAuthLoading, refreshUser } = useAuth()
  const [showTokenFallback, setShowTokenFallback] = useState(false)
  const [callbackToken, setCallbackToken] = useState("")
  const [isCompletingTokenLogin, setIsCompletingTokenLogin] = useState(false)
  const [authSuccessMessage, setAuthSuccessMessage] = useState("")

  useEffect(() => {
    if (!isAuthLoading && isAuthenticated && !authSuccessMessage) {
      router.replace("/")
    }
  }, [authSuccessMessage, isAuthLoading, isAuthenticated, router])

  const handleTokenLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const token = extractCallbackToken(callbackToken)
    if (!token) {
      toast.error("Paste a callback link.")
      return
    }

    setIsCompletingTokenLogin(true)
    try {
      await verifyCallbackToken(token)
      await refreshUser()
      setAuthSuccessMessage("Authenticated. Opening OpenLinear...")
      toast.success("Authenticated. Opening OpenLinear...")
      await new Promise((resolve) => window.setTimeout(resolve, 900))
      router.replace("/")
    } catch (err) {
      setAuthSuccessMessage("")
      if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) {
        toast.error("Could not verify the callback token because the desktop API is not ready. Try again in a moment.")
      } else {
        toast.error("That callback token was not accepted. Try signing in again.")
      }
    } finally {
      setIsCompletingTokenLogin(false)
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
          <p className="text-sm text-linear-text-secondary text-center mb-4">
            GitHub sign-in is disabled. Existing sessions still work until they expire.
          </p>

          <Button
            disabled
            className="w-full text-white opacity-60"
            style={{ backgroundColor: BRAND_COLORS.githubBg }}
          >
            <Github className="w-5 h-5 mr-2" />
            Sign in with GitHub
          </Button>

          {authSuccessMessage && (
            <div
              className="mt-4 flex items-center gap-2 rounded-sm border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-300"
              role="status"
              aria-live="polite"
            >
              <CheckCircle2 className="h-4 w-4 flex-none" />
              <span>{authSuccessMessage}</span>
            </div>
          )}

          <div className="mt-4 border-t border-linear-border pt-4">
            <button
              type="button"
              onClick={() => setShowTokenFallback((value) => !value)}
              className="mx-auto flex items-center gap-2 text-sm text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
            >
              <KeyRound className="w-4 h-4" />
              Trouble signing in?
            </button>

            {showTokenFallback && (
              <form onSubmit={handleTokenLogin} className="mt-3 space-y-3">
                <p className="text-xs text-linear-text-tertiary">
                  Use this only if your browser did not hand the callback back to OpenLinear.
                </p>
                <textarea
                  value={callbackToken}
                  onChange={(event) => setCallbackToken(event.target.value)}
                  placeholder="Paste openlinear://callback URL"
                  className="min-h-24 w-full resize-y rounded-sm border border-linear-border bg-linear-bg px-3 py-2 text-xs text-linear-text placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover font-mono"
                />
                <Button
                  type="submit"
                  disabled={isCompletingTokenLogin || Boolean(authSuccessMessage) || !callbackToken.trim()}
                  className="w-full bg-linear-accent hover:bg-linear-accent-hover text-white"
                >
                  {isCompletingTokenLogin ? (
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
        </div>

        <p className="text-center text-xs text-linear-text-tertiary mt-6">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  )
}
