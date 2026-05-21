"use client"

import { useState, useEffect, Suspense, useCallback } from "react"
import {
  Settings,
  Loader2,
  Globe,
  Palette,
  Bell,
  Cpu,
  Shield,
  Key,
  Database,
  Eye,
  EyeOff,
  Copy,
  RefreshCw,
  Monitor,
  Moon,
  Sun,
  Laptop,
  Check,
  Brain,
  AlertCircle,
  User as UserIcon,
  Github,
  Search,
} from "lucide-react"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSearchParams } from "next/navigation"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { DatabaseSettings } from "@/components/desktop/database-settings"
import { AIProvidersSection } from "@/components/settings/ai-providers-section"
import { PersonalAccessTokensSection } from "@/components/settings/personal-access-tokens-section"
import { getActiveRepository, setActiveRepositoryBaseBranch } from "@/lib/api"
import { apiFetch } from "@/lib/api/fetch"
import { startLogin, updateEmail } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { EmptyState } from "@/components/empty-state"

type SettingsSection =
  | "profile"
  | "general"
  | "appearance"
  | "notifications"
  | "ai-execution"
  | "ai-providers"
  | "security"
  | "api-keys"
  | "database"

const NAV_ITEMS: {
  id: SettingsSection
  label: string
  icon: React.ElementType
}[] = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "general", label: "General", icon: Globe },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "ai-execution", label: "AI Execution", icon: Cpu },
  { id: "ai-providers", label: "AI Providers", icon: Brain },
  { id: "security", label: "Security & Privacy", icon: Shield },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "database", label: "Database", icon: Database },
]

const DEFAULT_ACCENT = { accent: "#10b981", hover: "#059669" }
const LEGACY_ACCENTS = new Set(["#1d4ed8", "#1e40af", "#3b82f6", "#2563eb"])

function SettingsContent() {
  const searchParams = useSearchParams()
  const initialSection = (searchParams.get("section") as SettingsSection) || "profile"
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(initialSection)

  const { user, isLoading: authLoading, refreshUser } = useAuth()
  const [language, setLanguage] = useState("en")
  const [timezone, setTimezone] = useState("UTC")
  const [autoSave, setAutoSave] = useState(true)
  const [emailInput, setEmailInput] = useState("")
  const [emailSaving, setEmailSaving] = useState(false)

  const { theme, setTheme } = useTheme()
  const [compactMode, setCompactMode] = useState(false)
  const [animations, setAnimations] = useState(true)

  const [emailNotifications, setEmailNotifications] = useState(true)
  const [pushNotifications, setPushNotifications] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [mentionNotifs, setMentionNotifs] = useState(true)
  const [assignmentNotifs, setAssignmentNotifs] = useState(true)
  const [statusChangeNotifs, setStatusChangeNotifs] = useState(false)

  const [parallelLimit, setParallelLimit] = useState(3)
  const [maxBatchSize, setMaxBatchSize] = useState(3)
  const [queueAutoApprove, setQueueAutoApprove] = useState(false)
  const [stopOnFailure, setStopOnFailure] = useState(false)
  const [conflictBehavior, setConflictBehavior] = useState("skip")
  const [autoRetry, setAutoRetry] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [activeRepositoryId, setActiveRepositoryId] = useState<string | null>(null)
  const [activeRepositoryName, setActiveRepositoryName] = useState<string | null>(null)
  const [prBaseBranch, setPrBaseBranch] = useState("")
  const [savedPrBaseBranch, setSavedPrBaseBranch] = useState("")

  const handleGitHubLogin = useCallback(async () => {
    const started = await startLogin()
    if (!started) {
      toast.error("Could not open GitHub sign-in. Check that the desktop API is running and try again.")
    }
  }, [])

  useEffect(() => {
    if (user?.email) setEmailInput(user.email)
  }, [user?.email])

  const [twoFactor] = useState(false)
  const [sessionTimeout, setSessionTimeout] = useState("4h")

  const ACCENT_PRESETS = [
    { name: "Emerald", accent: DEFAULT_ACCENT.accent, hover: DEFAULT_ACCENT.hover },
    { name: "Purple", accent: "#8b5cf6", hover: "#7c3aed" },
    { name: "Green", accent: "#22c55e", hover: "#16a34a" },
    { name: "Orange", accent: "#f97316", hover: "#ea580c" },
    { name: "Pink", accent: "#ec4899", hover: "#db2777" },
    { name: "Red", accent: "#ef4444", hover: "#dc2626" },
    { name: "Teal", accent: "#14b8a6", hover: "#0d9488" },
    { name: "Yellow", accent: "#eab308", hover: "#ca8a04" },
  ] as const

  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT.accent)

  const applyAccentColor = (accent: string, hover: string) => {
    setAccentColor(accent)
    document.documentElement.style.setProperty("--linear-accent", accent)
    document.documentElement.style.setProperty("--linear-accent-hover", hover)
    try {
      localStorage.setItem("openlinear-accent", JSON.stringify({ accent, hover }))
    } catch {
    }
  }

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const [settingsData, activeRepository] = await Promise.all([
          apiFetch<{
            parallelLimit: number
            maxBatchSize?: number
            queueAutoApprove?: boolean
            stopOnFailure?: boolean
            conflictBehavior?: string
          }>('/api/settings').catch(() => null),
          getActiveRepository().catch(() => null),
        ])

        if (settingsData) {
          setParallelLimit(settingsData.parallelLimit)
          setMaxBatchSize(settingsData.maxBatchSize ?? 3)
          setQueueAutoApprove(settingsData.queueAutoApprove ?? false)
          setStopOnFailure(settingsData.stopOnFailure ?? false)
          setConflictBehavior(settingsData.conflictBehavior ?? "skip")
        }

        if (activeRepository) {
          const baseBranch = activeRepository.defaultBranch || "main"
          setActiveRepositoryId(activeRepository.id)
          setActiveRepositoryName(activeRepository.fullName)
          setPrBaseBranch(baseBranch)
          setSavedPrBaseBranch(baseBranch)
        } else {
          setActiveRepositoryId(null)
          setActiveRepositoryName(null)
          setPrBaseBranch("")
          setSavedPrBaseBranch("")
        }
      } catch (error) {
        console.error("Failed to fetch settings:", error)
        toast.error("Failed to load settings")
      } finally {
        setLoading(false)
      }
    }

    fetchSettings()
  }, [])

  useEffect(() => {
    try {
      const stored = localStorage.getItem("openlinear-accent")
      if (stored) {
        let { accent, hover } = JSON.parse(stored)
        if (LEGACY_ACCENTS.has(String(accent).toLowerCase()) || LEGACY_ACCENTS.has(String(hover).toLowerCase())) {
          accent = DEFAULT_ACCENT.accent
          hover = DEFAULT_ACCENT.hover
          localStorage.setItem("openlinear-accent", JSON.stringify({ accent, hover }))
        }
        setAccentColor(accent)
        document.documentElement.style.setProperty("--linear-accent", accent)
        document.documentElement.style.setProperty("--linear-accent-hover", hover)
      }
    } catch {
    }
  }, [])

  const handleSave = async () => {
    const normalizedBaseBranch = prBaseBranch.trim()

    if (activeRepositoryId && !normalizedBaseBranch) {
      toast.error("PR base branch cannot be empty")
      return
    }

    setSaving(true)
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          parallelLimit,
          maxBatchSize,
          queueAutoApprove,
          stopOnFailure,
          conflictBehavior,
        }),
      })

      if (
        activeRepositoryId &&
        normalizedBaseBranch !== savedPrBaseBranch
      ) {
        const repository = await setActiveRepositoryBaseBranch(normalizedBaseBranch)
        const savedBranch = repository.defaultBranch || normalizedBaseBranch
        setPrBaseBranch(savedBranch)
        setSavedPrBaseBranch(savedBranch)
        setActiveRepositoryName(repository.fullName)
      }

      toast.success("Settings saved")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save settings"
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const renderProfile = () => (
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
                  <Label className="text-xs text-linear-text-tertiary">
                    Username
                  </Label>
                  <Input
                    readOnly
                    value={user.username}
                    className="mt-1 bg-linear-bg border-linear-border text-linear-text"
                  />
                </div>
                <div>
                  <Label className="text-xs text-linear-text-tertiary">
                    Email
                  </Label>
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
                  <Label className="text-xs text-linear-text-tertiary">
                    GitHub ID
                  </Label>
                  <Input
                    readOnly
                    value={user.githubId ?? "Not linked"}
                    className="mt-1 bg-linear-bg border-linear-border text-linear-text font-mono"
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">Reconnect GitHub</p>
                  <p className="text-xs text-linear-text-tertiary">
                    Re-run OAuth to refresh permissions and pull latest profile
                    data.
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

  const renderGeneral = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">General</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Manage your workspace preferences and regional settings.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Regional</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Language and timezone preferences for your workspace.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3">
            <div>
              <p className="text-sm text-linear-text">Language</p>
              <p className="text-xs text-linear-text-tertiary">
                Display language for the interface
              </p>
            </div>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-full sm:w-40 bg-linear-bg border-linear-border text-linear-text">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg-secondary border-linear-border">
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Spanish</SelectItem>
                <SelectItem value="fr">French</SelectItem>
                <SelectItem value="ja">Japanese</SelectItem>
                <SelectItem value="de">German</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Timezone</p>
              <p className="text-xs text-linear-text-tertiary">
                Used for timestamps and scheduling
              </p>
            </div>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="w-full sm:w-48 bg-linear-bg border-linear-border text-linear-text">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg-secondary border-linear-border">
                <SelectItem value="UTC">UTC</SelectItem>
                <SelectItem value="America/New_York">
                  Eastern (ET)
                </SelectItem>
                <SelectItem value="America/Chicago">
                  Central (CT)
                </SelectItem>
                <SelectItem value="America/Denver">
                  Mountain (MT)
                </SelectItem>
                <SelectItem value="America/Los_Angeles">
                  Pacific (PT)
                </SelectItem>
                <SelectItem value="Europe/London">London (GMT)</SelectItem>
                <SelectItem value="Europe/Berlin">Berlin (CET)</SelectItem>
                <SelectItem value="Asia/Tokyo">Tokyo (JST)</SelectItem>
                <SelectItem value="Asia/Kolkata">India (IST)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Behavior</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Auto-save</p>
              <p className="text-xs text-linear-text-tertiary">
                Automatically save changes as you work
              </p>
            </div>
            <Switch checked={autoSave} onCheckedChange={setAutoSave} />
          </div>
        </CardContent>
      </Card>
    </div>
  )

  const renderAppearance = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">Appearance</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Customize the look and feel of your workspace.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Theme</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Choose your preferred color theme.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                { value: "dark" as const, label: "Dark", icon: Moon, disabled: false },
                { value: "light" as const, label: "Light", icon: Sun, disabled: true },
                { value: "system" as const, label: "System", icon: Laptop, disabled: false },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                onClick={() => !option.disabled && setTheme(option.value)}
                disabled={option.disabled}
                title={option.disabled ? "Light theme coming soon" : undefined}
                className={`flex flex-col items-center gap-2 p-4 rounded-sm border transition-colors ${
                  option.disabled
                    ? "border-linear-border bg-linear-bg text-linear-text-tertiary opacity-50 cursor-not-allowed"
                    : theme === option.value
                    ? "border-linear-accent bg-linear-accent/10 text-linear-text"
                    : "border-linear-border bg-linear-bg text-linear-text-secondary hover:text-linear-text hover:border-linear-border"
                }`}
              >
                <option.icon className="w-5 h-5" />
                <span className="text-sm font-medium">{option.label}</span>
                {option.disabled && (
                  <span className="text-[10px] text-linear-text-tertiary">Coming soon</span>
                )}
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Accent Color</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Choose the accent color used throughout the interface.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-3">
            {ACCENT_PRESETS.map((preset) => (
              <button
                key={preset.name}
                onClick={() => applyAccentColor(preset.accent, preset.hover)}
                className={`flex flex-col items-center gap-2 p-3 rounded-sm border transition-colors ${
                  accentColor === preset.accent
                    ? "border-linear-accent bg-linear-accent/10"
                    : "border-linear-border hover:border-linear-border-hover"
                }`}
              >
                <div className="relative">
                  <div
                    className="w-8 h-8 rounded-full"
                    style={{ backgroundColor: preset.accent }}
                  />
                  {accentColor === preset.accent && (
                    <Check className="absolute inset-0 m-auto w-4 h-4 text-white" />
                    )}
                  </div>
                <span className="text-xs text-linear-text-secondary">
                  {preset.name}
                </span>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Display</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Compact mode</p>
              <p className="text-xs text-linear-text-tertiary">
                Reduce spacing and padding throughout the interface
              </p>
            </div>
            <Switch
              checked={compactMode}
              onCheckedChange={setCompactMode}
            />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Animations</p>
              <p className="text-xs text-linear-text-tertiary">
                Enable smooth transitions and motion effects
              </p>
            </div>
            <Switch
              checked={animations}
              onCheckedChange={setAnimations}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )

  const renderNotifications = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">
          Notifications
        </h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Configure how and when you receive notifications.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            <Bell className="w-4 h-4 text-linear-text-tertiary flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm text-linear-text">
                Per-user notification preferences are coming soon
              </p>
              <p className="text-xs text-linear-text-tertiary">
                The controls below are previews and don&apos;t persist yet.
                You&apos;ll still receive in-app notifications for mentions,
                assignments, and PR updates from the inbox.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border opacity-60">
        <CardHeader>
          <CardTitle className="text-linear-text">Channels</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Choose how you want to be notified.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">
                Email notifications
              </p>
              <p className="text-xs text-linear-text-tertiary">
                Receive updates via email
              </p>
            </div>
            <Switch checked={emailNotifications} disabled />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">
                Push notifications
              </p>
              <p className="text-xs text-linear-text-tertiary">
                Browser and desktop push alerts
              </p>
            </div>
            <Switch checked={pushNotifications} disabled />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Sound</p>
              <p className="text-xs text-linear-text-tertiary">
                Play a sound for incoming notifications
              </p>
            </div>
            <Switch checked={soundEnabled} disabled />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border opacity-60">
        <CardHeader>
          <CardTitle className="text-linear-text">Event Types</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Fine-tune which events trigger notifications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Mentions</p>
              <p className="text-xs text-linear-text-tertiary">
                When someone mentions you in a comment
              </p>
            </div>
            <Switch checked={mentionNotifs} disabled />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Assignments</p>
              <p className="text-xs text-linear-text-tertiary">
                When a task is assigned to you
              </p>
            </div>
            <Switch checked={assignmentNotifs} disabled />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Status changes</p>
              <p className="text-xs text-linear-text-tertiary">
                When a task you are watching changes status
              </p>
            </div>
            <Switch checked={statusChangeNotifs} disabled />
          </div>
        </CardContent>
      </Card>
    </div>
  )

  const renderAIExecution = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">
          AI Execution
        </h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Configure parallel execution and batch processing for AI agents.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">
            Parallel Execution
          </CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Configure how many AI agents can run simultaneously when
            processing tasks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-linear-text-secondary">
                  Parallel Limit
                </span>
                <span className="text-lg font-semibold text-linear-accent">
                  {parallelLimit}
                </span>
              </div>
              <Slider
                value={[parallelLimit]}
                onValueChange={(value) => setParallelLimit(value[0])}
                min={1}
                max={5}
                step={1}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-linear-text-tertiary">
                <span>1 (Sequential)</span>
                <span>5 (Maximum)</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">
            Batch Execution
          </CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Configure batch execution behavior for running multiple tasks
            together.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-linear-text-secondary">
                  Max Batch Size
                </span>
                <span className="text-lg font-semibold text-linear-accent">
                  {maxBatchSize}
                </span>
              </div>
              <Slider
                value={[maxBatchSize]}
                onValueChange={(value) => setMaxBatchSize(value[0])}
                min={1}
                max={10}
                step={1}
                className="w-full"
              />
              <div className="flex justify-between text-xs text-linear-text-tertiary">
                <span>1</span>
                <span>10</span>
              </div>

              <div className="flex items-center justify-between py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">
                    Auto-Approve Queue
                  </p>
                  <p className="text-xs text-linear-text-tertiary">
                    Automatically start the next task in queue mode
                  </p>
                </div>
                <Switch
                  checked={queueAutoApprove}
                  onCheckedChange={setQueueAutoApprove}
                />
              </div>

              <div className="flex items-center justify-between py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">
                    Stop on Failure
                  </p>
                  <p className="text-xs text-linear-text-tertiary">
                    Cancel remaining tasks if one fails
                  </p>
                </div>
                <Switch
                  checked={stopOnFailure}
                  onCheckedChange={setStopOnFailure}
                />
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">
                    Merge Conflict Behavior
                  </p>
                  <p className="text-xs text-linear-text-tertiary">
                    What to do when task branches conflict
                  </p>
                </div>
                <Select
                  value={conflictBehavior}
                  onValueChange={setConflictBehavior}
                >
                  <SelectTrigger className="w-full sm:w-32 bg-linear-bg border-linear-border text-linear-text">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-linear-bg-secondary border-linear-border">
                    <SelectItem value="skip">Skip</SelectItem>
                    <SelectItem value="fail">Fail</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">Auto-Retry</p>
                  <p className="text-xs text-linear-text-tertiary">
                    Automatically retry failed executions once
                  </p>
                </div>
                <Switch
                  checked={autoRetry}
                  onCheckedChange={setAutoRetry}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Pull Request Target</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Choose the base branch OpenLinear uses for new pull requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-linear-text-tertiary">
            {activeRepositoryName
              ? `Active repository: ${activeRepositoryName}`
              : "No active repository selected"}
          </p>
          <div className="space-y-2">
            <Label htmlFor="pr-base-branch" className="text-sm text-linear-text block">
              Base branch
            </Label>
            <Input
              id="pr-base-branch"
              type="text"
              value={prBaseBranch}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setPrBaseBranch(e.target.value)
              }
              placeholder={activeRepositoryId ? "main" : "Select a repository first"}
              disabled={!activeRepositoryId || loading}
              className="bg-linear-bg border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
            />
            <p className="text-xs text-linear-text-tertiary">
              This branch is used for clone base and PR target.
            </p>
          </div>
        </CardContent>
      </Card>

      {!loading && (
        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-linear-accent hover:bg-linear-accent-hover text-white"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Changes"
            )}
          </Button>
        </div>
      )}
    </div>
  )

  const renderSecurity = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">
          Security & Privacy
        </h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Manage authentication and session security.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Authentication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">
                Two-factor authentication
              </p>
              <p className="text-xs text-linear-text-tertiary">
                Add an extra layer of security to your account.{" "}
                <span className="text-linear-text-tertiary">Coming soon.</span>
              </p>
            </div>
            <Switch checked={twoFactor} disabled aria-label="Two-factor authentication (coming soon)" />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Session timeout</p>
              <p className="text-xs text-linear-text-tertiary">
                Automatically log out after a period of inactivity
              </p>
            </div>
            <Select
              value={sessionTimeout}
              onValueChange={setSessionTimeout}
            >
              <SelectTrigger className="w-full sm:w-36 bg-linear-bg border-linear-border text-linear-text">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg-secondary border-linear-border">
                <SelectItem value="30m">30 minutes</SelectItem>
                <SelectItem value="1h">1 hour</SelectItem>
                <SelectItem value="4h">4 hours</SelectItem>
                <SelectItem value="8h">8 hours</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">
            Active Sessions
          </CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Devices currently signed into your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Shield}
            size="compact"
            title="No active session data yet"
            description="Per-device session tracking will appear here once it ships."
          />
        </CardContent>
      </Card>
    </div>
  )

  const renderApiKeys = () => <PersonalAccessTokensSection />

  const renderDatabase = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">Database</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Manage your database connection and configuration.
        </p>
      </div>

      <DatabaseSettings />
    </div>
  )

  const renderContent = () => {
    switch (activeSection) {
      case "profile":
        return renderProfile()
      case "general":
        return renderGeneral()
      case "appearance":
        return renderAppearance()
      case "notifications":
        return renderNotifications()
      case "ai-execution":
        return renderAIExecution()
      case "ai-providers":
        return <AIProvidersSection />
      case "security":
        return renderSecurity()
      case "api-keys":
        return renderApiKeys()
      case "database":
        return renderDatabase()
    }
  }

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Settings className="w-4 h-4 text-linear-text-secondary flex-shrink-0" />
          <h1 className="text-lg font-semibold truncate">Settings</h1>
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>

      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
        <nav className="flex-shrink-0 border-b md:border-b-0 md:border-r border-linear-border bg-linear-bg overflow-x-auto md:overflow-y-auto md:w-52 py-2 md:py-3 px-2 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          <div className="flex md:flex-col gap-1 min-w-max md:min-w-0">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = activeSection === item.id
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-sm text-sm whitespace-nowrap transition-colors ${
                  isActive
                    ? "bg-linear-bg-tertiary text-linear-text"
                    : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {item.label}
              </button>
            )
          })}
          </div>
        </nav>

        <main className="flex-1 overflow-y-auto p-6 sm:p-8">
          <div className="max-w-2xl pb-8">{renderContent()}</div>
        </main>
      </div>
    </>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen bg-linear-bg"><Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" /></div>}>
      <SettingsContent />
    </Suspense>
  )
}
