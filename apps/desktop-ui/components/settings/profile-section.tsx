"use client"

import { useState, useEffect, useCallback } from "react"
import { Loader2, User as UserIcon, Github } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import { startLogin, updateEmail } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { EmptyState } from "@/components/empty-state"

export function ProfileSection() {
  const { user, isLoading: authLoading, refreshUser } = useAuth()
  const [emailInput, setEmailInput] = useState("")
  const [emailSaving, setEmailSaving] = useState(false)

  const handleGitHubLogin = useCallback(async () => {
    const started = await startLogin()
    if (!started) {
      toast.error("Could not open GitHub sign-in. Check that the desktop API is running and try again.")
    }
  }, [])

  useEffect(() => {
    if (user?.email) setEmailInput(user.email)
  }, [user?.email])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">Profile</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Your account is managed by GitHub. Update your name, email, or avatar
          on GitHub and reconnect to sync changes.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Account</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Synced from GitHub. Read-only here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {authLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" />
            </div>
          ) : !user ? (
            <EmptyState
              icon={UserIcon}
              title="Not signed in"
              description="Sign in with GitHub to manage your profile."
              action={
                <Button
                  onClick={() => void handleGitHubLogin()}
                  className="bg-linear-accent hover:bg-linear-accent-hover text-white gap-2"
                >
                  <Github className="w-4 h-4" />
                  Sign in with GitHub
                </Button>
              }
            />
          ) : (
            <>
              <div className="flex items-center gap-4">
                {user.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={user.avatarUrl}
                    alt={user.username}
                    className="w-16 h-16 rounded-full object-cover ring-2 ring-linear-border shadow-sm"
                  />
                ) : (
                  <div className="w-16 h-16 rounded-full bg-linear-bg-tertiary ring-2 ring-linear-border shadow-sm flex items-center justify-center">
                    <UserIcon className="w-7 h-7 text-linear-text-tertiary" />
                  </div>
                )}
                <div className="min-w-0">
                  <p className="text-base font-medium text-linear-text truncate">
                    {user.username}
                  </p>
                  <p className="text-sm text-linear-text-tertiary truncate">
                    {user.email || "Add your email below"}
                  </p>
                </div>
              </div>

              <div className="space-y-3 pt-2 border-t border-linear-border">
                <div>
                  <Label className="text-xs text-linear-text-tertiary">Username</Label>
                  <Input readOnly value={user.username} className="mt-1 bg-linear-bg border-linear-border text-linear-text" />
                </div>
                <div>
                  <Label className="text-xs text-linear-text-tertiary">Email</Label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      placeholder="Enter your email"
                      className="bg-linear-bg border-linear-border text-linear-text"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={emailSaving || !emailInput.trim() || emailInput.trim().toLowerCase() === (user?.email || "").toLowerCase()}
                      onClick={async () => {
                        setEmailSaving(true)
                        try {
                          await updateEmail(emailInput.trim())
                          await refreshUser()
                          toast.success("Email updated")
                        } catch (err: unknown) {
                          const msg = err instanceof Error ? err.message : "Failed to update email"
                          toast.error(msg)
                        } finally {
                          setEmailSaving(false)
                        }
                      }}
                    >
                      {emailSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
                    </Button>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-linear-text-tertiary">GitHub ID</Label>
                  <Input readOnly value={user.githubId ?? "Not linked"} className="mt-1 bg-linear-bg border-linear-border text-linear-text font-mono" />
                </div>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">Reconnect GitHub</p>
                  <p className="text-xs text-linear-text-tertiary">
                    Re-run OAuth to refresh permissions and pull latest profile data.
                  </p>
                </div>
                <Button
                  variant="outline"
                  onClick={() => void handleGitHubLogin()}
                  className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary gap-2"
                >
                  <Github className="w-4 h-4" />
                  Reconnect
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
