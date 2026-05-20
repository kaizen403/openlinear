"use client"

import { Github, KeyRound, Loader2 } from "lucide-react"
import { useEffect, useState, type FormEvent, type MouseEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ApiError, NetworkError, extractCallbackToken, startLogin, verifyCallbackToken } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { toast } from "sonner"

export default function LoginPage() {
  const router = useRouter()
  const { isAuthenticated, isLoading: isAuthLoading, refreshUser } = useAuth()
  const [isStartingLogin, setIsStartingLogin] = useState(false)
  const [showTokenFallback, setShowTokenFallback] = useState(false)
  const [callbackToken, setCallbackToken] = useState("")
  const [isCompletingTokenLogin, setIsCompletingTokenLogin] = useState(false)

  useEffect(() => {
    if (!isAuthLoading && isAuthenticated) {
      router.replace("/")
    }
  }, [isAuthLoading, isAuthenticated, router])

  const handleGitHubLogin = async () => {
    setIsStartingLogin(true)
    try {
      const started = await startLogin()
      if (!started) {
        toast.error("Could not open GitHub sign-in. Check that the desktop API is running and try again.")
        return
      }
      setShowTokenFallback(true)
    } catch {
      toast.error("Could not open GitHub sign-in. Check that the desktop API is running and try again.")
    } finally {
      setIsStartingLogin(false)
    }
  }

  const handleCancel = () => {
    setIsStartingLogin(false)
  }

  const handleTokenLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const token = extractCallbackToken(callbackToken)
    if (!token) {
      toast.error("Paste the token from the browser callback page.")
      return
    }

    setIsCompletingTokenLogin(true)
    try {
      await verifyCallbackToken(token)
      await refreshUser()
      toast.success("Signed in with GitHub")
      router.replace("/")
    } catch (err) {
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
            Sign in with your GitHub account to access OpenLinear
          </p>

          <Button
            onClick={handleGitHubLogin}
            disabled={isStartingLogin}
            className="w-full text-white"
            style={{ backgroundColor: BRAND_COLORS.githubBg }}
            onMouseEnter={(e: MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = BRAND_COLORS.githubBgHover }}
            onMouseLeave={(e: MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = BRAND_COLORS.githubBg }}
          >
            {isStartingLogin ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Redirecting to GitHub...
              </>
            ) : (
              <>
                <Github className="w-5 h-5 mr-2" />
                Sign in with GitHub
              </>
            )}
          </Button>

          {isStartingLogin && (
            <button
              onClick={handleCancel}
              className="w-full mt-3 text-sm text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
            >
              Cancel
            </button>
          )}

          <div className="mt-4 border-t border-linear-border pt-4">
            <button
              type="button"
              onClick={() => setShowTokenFallback((value) => !value)}
              className="mx-auto flex items-center gap-2 text-sm text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
            >
              <KeyRound className="w-4 h-4" />
              Enter callback token
            </button>

            {showTokenFallback && (
              <form onSubmit={handleTokenLogin} className="mt-3 space-y-3">
                <p className="text-xs text-linear-text-tertiary">
                  If the browser callback does not return to the app, paste the token or app link from that page here.
                </p>
                <textarea
                  value={callbackToken}
                  onChange={(event) => setCallbackToken(event.target.value)}
                  placeholder="Paste token or openlinear://callback URL"
                  className="min-h-24 w-full resize-y rounded-sm border border-linear-border bg-linear-bg px-3 py-2 text-xs text-linear-text placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-border-hover font-mono"
                />
                <Button
                  type="submit"
                  disabled={isCompletingTokenLogin || !callbackToken.trim()}
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
