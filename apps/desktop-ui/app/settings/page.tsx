"use client"

import { useState, useEffect } from "react"
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
} from "lucide-react"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
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
import { toast } from "sonner"
import { DatabaseSettings } from "@/components/desktop/database-settings"
import { AppShell } from "@/components/layout/app-shell"

type SettingsSection =
  | "general"
  | "appearance"
  | "notifications"
  | "ai-execution"
  | "security"
  | "api-keys"
  | "database"

const NAV_ITEMS: {
  id: SettingsSection
  label: string
  icon: React.ElementType
}[] = [
  { id: "general", label: "General", icon: Globe },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "ai-execution", label: "AI Execution", icon: Cpu },
  { id: "security", label: "Security & Privacy", icon: Shield },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "database", label: "Database", icon: Database },
]

export default function SettingsPage() {
  const [activeSection, setActiveSection] =
    useState<SettingsSection>("general")

  const [language, setLanguage] = useState("en")
  const [timezone, setTimezone] = useState("UTC")
  const [autoSave, setAutoSave] = useState(true)

  const [theme, setTheme] = useState<"dark" | "light" | "system">("dark")
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

  const [twoFactor, setTwoFactor] = useState(false)
  const [sessionTimeout, setSessionTimeout] = useState("4h")

  const [showApiKey, setShowApiKey] = useState(false)
  const maskedKey = "sk-ol-************************************a3f7"
  const fullKey = "sk-ol-9d8f7e6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a3f7"

  const ACCENT_PRESETS = [
    { name: "Blue", accent: "#3b82f6", hover: "#2563eb" },
    { name: "Purple", accent: "#8b5cf6", hover: "#7c3aed" },
    { name: "Green", accent: "#22c55e", hover: "#16a34a" },
    { name: "Orange", accent: "#f97316", hover: "#ea580c" },
    { name: "Pink", accent: "#ec4899", hover: "#db2777" },
    { name: "Red", accent: "#ef4444", hover: "#dc2626" },
    { name: "Teal", accent: "#14b8a6", hover: "#0d9488" },
    { name: "Yellow", accent: "#eab308", hover: "#ca8a04" },
  ] as const

  const [accentColor, setAccentColor] = useState("#3b82f6")

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
        const response = await fetch("http://localhost:3001/api/settings")
        if (response.ok) {
          const data = await response.json()
          setParallelLimit(data.parallelLimit)
          setMaxBatchSize(data.maxBatchSize ?? 3)
          setQueueAutoApprove(data.queueAutoApprove ?? false)
          setStopOnFailure(data.stopOnFailure ?? false)
          setConflictBehavior(data.conflictBehavior ?? "skip")
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
        const { accent, hover } = JSON.parse(stored)
        setAccentColor(accent)
        document.documentElement.style.setProperty("--linear-accent", accent)
        document.documentElement.style.setProperty("--linear-accent-hover", hover)
      }
    } catch {
    }
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await fetch("http://localhost:3001/api/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parallelLimit,
          maxBatchSize,
          queueAutoApprove,
          stopOnFailure,
          conflictBehavior,
        }),
      })

      if (response.ok) {
        toast.success("Settings saved successfully")
      } else {
        toast.error("Failed to save settings")
      }
    } catch (error) {
      console.error("Failed to save settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  const handleCopyApiKey = () => {
    navigator.clipboard.writeText(fullKey)
    toast.success("API key copied to clipboard")
  }


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
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Language</p>
              <p className="text-xs text-linear-text-tertiary">
                Display language for the interface
              </p>
            </div>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-40 bg-linear-bg border-linear-border text-linear-text">
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

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Timezone</p>
              <p className="text-xs text-linear-text-tertiary">
                Used for timestamps and scheduling
              </p>
            </div>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="w-48 bg-linear-bg border-linear-border text-linear-text">
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
                { value: "dark" as const, label: "Dark", icon: Moon },
                { value: "light" as const, label: "Light", icon: Sun },
                { value: "system" as const, label: "System", icon: Laptop },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                onClick={() => setTheme(option.value)}
                className={`flex flex-col items-center gap-2 p-4 rounded-lg border transition-colors ${
                  theme === option.value
                    ? "border-linear-accent bg-linear-accent/10 text-linear-text"
                    : "border-linear-border bg-linear-bg text-linear-text-secondary hover:text-linear-text hover:border-linear-border"
                }`}
              >
                <option.icon className="w-5 h-5" />
                <span className="text-sm font-medium">{option.label}</span>
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
                className={`flex flex-col items-center gap-2 p-3 rounded-lg border transition-colors ${
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
            <Switch
              checked={emailNotifications}
              onCheckedChange={setEmailNotifications}
            />
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
            <Switch
              checked={pushNotifications}
              onCheckedChange={setPushNotifications}
            />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Sound</p>
              <p className="text-xs text-linear-text-tertiary">
                Play a sound for incoming notifications
              </p>
            </div>
            <Switch
              checked={soundEnabled}
              onCheckedChange={setSoundEnabled}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
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
            <Switch
              checked={mentionNotifs}
              onCheckedChange={setMentionNotifs}
            />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Assignments</p>
              <p className="text-xs text-linear-text-tertiary">
                When a task is assigned to you
              </p>
            </div>
            <Switch
              checked={assignmentNotifs}
              onCheckedChange={setAssignmentNotifs}
            />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Status changes</p>
              <p className="text-xs text-linear-text-tertiary">
                When a task you are watching changes status
              </p>
            </div>
            <Switch
              checked={statusChangeNotifs}
              onCheckedChange={setStatusChangeNotifs}
            />
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

              <div className="flex items-center justify-between py-3 border-t border-linear-border">
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
                  <SelectTrigger className="w-32 bg-linear-bg border-linear-border text-linear-text">
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
                Add an extra layer of security to your account
              </p>
            </div>
            <Switch
              checked={twoFactor}
              onCheckedChange={setTwoFactor}
            />
          </div>

          <div className="flex items-center justify-between py-3 border-t border-linear-border">
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
              <SelectTrigger className="w-36 bg-linear-bg border-linear-border text-linear-text">
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
        <CardContent className="space-y-4">
          {[
            {
              device: "MacBook Pro - Chrome",
              ip: "192.168.1.42",
              lastActive: "Active now",
              current: true,
            },
            {
              device: "iPhone 15 - Safari",
              ip: "10.0.0.15",
              lastActive: "2 hours ago",
              current: false,
            },
            {
              device: "Windows Desktop - Firefox",
              ip: "172.16.0.8",
              lastActive: "3 days ago",
              current: false,
            },
          ].map((session, i) => (
            <div
              key={i}
              className={`flex items-center justify-between py-3 ${
                i > 0 ? "border-t border-linear-border" : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <Monitor className="w-4 h-4 text-linear-text-tertiary flex-shrink-0" />
                <div>
                  <p className="text-sm text-linear-text">
                    {session.device}
                    {session.current && (
                      <span className="ml-2 text-xs text-linear-accent font-medium">
                        Current
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-linear-text-tertiary">
                    {session.ip} &middot; {session.lastActive}
                  </p>
                </div>
              </div>
              {!session.current && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-linear-border text-linear-text-secondary hover:text-linear-text"
                >
                  Revoke
                </Button>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )

  const renderApiKeys = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">API Keys</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Manage API keys and integrations for your workspace.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">
            Personal API Key
          </CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Use this key to authenticate API requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center h-10 px-3 rounded-md bg-linear-bg border border-linear-border font-mono text-sm text-linear-text-secondary">
              {showApiKey ? fullKey : maskedKey}
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setShowApiKey(!showApiKey)}
              className="border-linear-border text-linear-text-secondary hover:text-linear-text flex-shrink-0"
            >
              {showApiKey ? (
                <EyeOff className="w-4 h-4" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopyApiKey}
              className="border-linear-border text-linear-text-secondary hover:text-linear-text flex-shrink-0"
            >
              <Copy className="w-4 h-4" />
            </Button>
          </div>

          <div className="pt-2">
            <Button variant="destructive" size="sm" className="gap-2">
              <RefreshCw className="w-3.5 h-3.5" />
              Regenerate Key
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Webhooks</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8 text-linear-text-tertiary">
            <p className="text-sm">Webhooks coming soon</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )

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
      case "general":
        return renderGeneral()
      case "appearance":
        return renderAppearance()
      case "notifications":
        return renderNotifications()
      case "ai-execution":
        return renderAIExecution()
      case "security":
        return renderSecurity()
      case "api-keys":
        return renderApiKeys()
      case "database":
        return renderDatabase()
    }
  }

  return (
    <AppShell>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Settings className="w-4 h-4 text-linear-text-secondary flex-shrink-0" />
          <h1 className="text-lg font-semibold truncate">Settings</h1>
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>

      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        <nav className="flex-shrink-0 border-b md:border-b-0 md:border-r border-linear-border bg-linear-bg overflow-x-auto md:overflow-y-auto md:w-52 py-2 md:py-3 px-2">
          <div className="flex md:flex-col gap-1 min-w-max md:min-w-0">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const isActive = activeSection === item.id
            return (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-md text-sm whitespace-nowrap transition-colors ${
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
          <div className="max-w-2xl">{renderContent()}</div>
        </main>
      </div>
    </AppShell>
  )
}
