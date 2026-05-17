"use client"

import { Github, Loader2 } from "lucide-react"
import { useEffect, useState, type MouseEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { startLogin } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { BRAND_COLORS } from "@/lib/design-tokens"
import { toast } from "sonner"

export default function LoginPage() {
  const router = useRouter()
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth()
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!isAuthLoading && isAuthenticated) {
      router.replace("/")
    }
  }, [isAuthLoading, isAuthenticated, router])

  const handleGitHubLogin = async () => {
    setIsLoading(true)
    try {
      const started = await startLogin()
      if (!started) {
        toast.error("Could not open GitHub sign-in. Check that the desktop API is running and try again.")
        setIsLoading(false)
      }
    } catch {
      toast.error("Could not open GitHub sign-in. Check that the desktop API is running and try again.")
      setIsLoading(false)
    }
  }

  const handleCancel = () => {
    setIsLoading(false)
  }

  return (
    <div className="min-h-screen bg-linear-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <img src="/brand/wordmark.svg" alt="OpenLinear" className="h-12 mx-auto mb-4" />
          <p className="text-sm text-linear-text-secondary">Sign in to continue</p>
        </div>

        <div className="bg-linear-bg-secondary border border-linear-border rounded-sm p-6">
          <p className="text-sm text-linear-text-secondary text-center mb-4">
            Sign in with your GitHub account to access OpenLinear
          </p>

          <Button
            onClick={handleGitHubLogin}
            disabled={isLoading}
            className="w-full text-white"
            style={{ backgroundColor: BRAND_COLORS.githubBg }}
            onMouseEnter={(e: MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = BRAND_COLORS.githubBgHover }}
            onMouseLeave={(e: MouseEvent<HTMLButtonElement>) => { e.currentTarget.style.backgroundColor = BRAND_COLORS.githubBg }}
          >
            {isLoading ? (
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

          {isLoading && (
            <button
              onClick={handleCancel}
              className="w-full mt-3 text-sm text-linear-text-tertiary hover:text-linear-text-secondary transition-colors"
            >
              Cancel
            </button>
          )}
        </div>

        <p className="text-center text-xs text-linear-text-tertiary mt-6">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  )
}
