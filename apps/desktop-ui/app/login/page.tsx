"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Github, Loader2, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { loginUser, registerUser, getLoginUrl } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"

type Tab = "email" | "github"

export default function LoginPage() {
  const router = useRouter()
  const { refreshUser } = useAuth()
  const [activeTab, setActiveTab] = useState<Tab>("email")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      const data = await loginUser(username, password)
      localStorage.setItem("token", data.token)
      await refreshUser()
      router.push("/")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
    } finally {
      setIsLoading(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setIsLoading(true)

    try {
      const data = await registerUser(username, password)
      localStorage.setItem("token", data.token)
      await refreshUser()
      router.push("/")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Registration failed")
    } finally {
      setIsLoading(false)
    }
  }

  const handleGitHubLogin = () => {
    window.location.href = getLoginUrl()
  }

  return (
    <div className="min-h-screen bg-linear-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo / Header */}
        <div className="text-center mb-8">
          <img
            src="/logo.png"
            alt="KazCode"
            className="h-12 mx-auto mb-4"
          />
          <p className="text-sm text-linear-text-secondary">
            Sign in to continue
          </p>
        </div>

        {/* Card */}
        <div className="bg-linear-bg-secondary border border-linear-border rounded-lg overflow-hidden">
          {/* Tab Buttons */}
          <div className="flex border-b border-linear-border">
            <button
              onClick={() => setActiveTab("email")}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === "email"
                  ? "text-linear-text border-b-2 border-linear-accent"
                  : "text-linear-text-secondary hover:text-linear-text"
              }`}
            >
              Email / Password
            </button>
            <button
              onClick={() => setActiveTab("github")}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === "github"
                  ? "text-linear-text border-b-2 border-linear-accent"
                  : "text-linear-text-secondary hover:text-linear-text"
              }`}
            >
              GitHub
            </button>
          </div>

          {/* Content */}
          <div className="p-6">
            {activeTab === "email" && (
              <div className="space-y-4">
                <form onSubmit={isRegistering ? handleRegister : handleLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="username" className="text-linear-text">
                      Username
                    </Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder="Enter your username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="bg-linear-bg border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-accent"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-linear-text">
                      Password
                    </Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Enter your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="bg-linear-bg border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-accent"
                      required
                    />
                  </div>

                  {error && (
                    <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20">
                      <p className="text-sm text-destructive">{error}</p>
                    </div>
                  )}

                  <div className="flex gap-3 pt-2">
                    <Button
                      type="submit"
                      disabled={isLoading}
                      className="flex-1 bg-linear-accent hover:bg-linear-accent-hover text-white"
                    >
                      {isLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          {isRegistering ? "Creating account..." : "Signing in..."}
                        </>
                      ) : (
                        isRegistering ? "Create Account" : "Sign In"
                      )}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setIsRegistering(!isRegistering)
                        setError(null)
                      }}
                      className="border-linear-border text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary"
                    >
                      <UserPlus className="w-4 h-4 mr-2" />
                      {isRegistering ? "Back to Login" : "Register"}
                    </Button>
                  </div>
                </form>
              </div>
            )}

            {activeTab === "github" && (
              <div className="space-y-4">
                <p className="text-sm text-linear-text-secondary text-center">
                  Sign in with your GitHub account to access KazCode
                </p>

                {error && (
                  <div className="p-3 rounded-md bg-destructive/10 border border-destructive/20">
                    <p className="text-sm text-destructive">{error}</p>
                  </div>
                )}

                <Button
                  onClick={handleGitHubLogin}
                  className="w-full bg-[#24292e] hover:bg-[#1b1f23] text-white"
                >
                  <Github className="w-5 h-5 mr-2" />
                  Sign in with GitHub
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-linear-text-tertiary mt-6">
          By signing in, you agree to our Terms of Service and Privacy Policy
        </p>
      </div>
    </div>
  )
}
