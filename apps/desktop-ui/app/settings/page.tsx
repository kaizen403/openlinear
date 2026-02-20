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
  ExternalLink,
  Pencil,
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
import { toast } from "sonner"
import { DatabaseSettings } from "@/components/desktop/database-settings"
import { ensureContainer, getSetupStatus, setProviderApiKey, getProviderAuthMethods, oauthAuthorize, oauthCallback, addConfiguredProvider, getModels, getModelConfig, setModel, SetupStatus, ProviderAuthMethods, ProviderModels } from "@/lib/api/opencode"
import { getActiveRepository, setActiveRepositoryBaseBranch } from "@/lib/api"
import { AppShell } from "@/components/layout/app-shell"
import { API_URL } from "@/lib/api/client"

type SettingsSection =
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
  { id: "general", label: "General", icon: Globe },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "ai-execution", label: "AI Execution", icon: Cpu },
  { id: "ai-providers", label: "AI Providers", icon: Brain },
  { id: "security", label: "Security & Privacy", icon: Shield },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "database", label: "Database", icon: Database },
]

const OAUTH_CALLBACK_STORAGE_KEY = "opencode-oauth-callback"
const OAUTH_PENDING_STORAGE_KEY = "opencode-oauth-pending"

function SettingsContent() {
  const searchParams = useSearchParams()
  const initialSection = (searchParams.get("section") as SettingsSection) || "general"
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(initialSection)

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
  const [activeRepositoryId, setActiveRepositoryId] = useState<string | null>(null)
  const [activeRepositoryName, setActiveRepositoryName] = useState<string | null>(null)
  const [prBaseBranch, setPrBaseBranch] = useState("")
  const [savedPrBaseBranch, setSavedPrBaseBranch] = useState("")

  const [twoFactor, setTwoFactor] = useState(false)
  const [sessionTimeout, setSessionTimeout] = useState("4h")

  const [showApiKey, setShowApiKey] = useState(false)
  const maskedKey = "sk-ol-************************************a3f7"
  const fullKey = "sk-ol-9d8f7e6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a3f7"

  const [providersLoading, setProvidersLoading] = useState(false)
  const [providerSetupStatus, setProviderSetupStatus] = useState<SetupStatus | null>(null)
  const [providerInputs, setProviderInputs] = useState<Record<string, { key: string; saving: boolean; saved: boolean }>>({})
  const [providerError, setProviderError] = useState<string | null>(null)
  const [providerAuthMethodsMap, setProviderAuthMethodsMap] = useState<ProviderAuthMethods>({})
  const [oauthLoadingProvider, setOauthLoadingProvider] = useState<string | null>(null)
  const [oauthWaitingProvider, setOauthWaitingProvider] = useState<string | null>(null)
  const [oauthCallbackInputs, setOauthCallbackInputs] = useState<Record<string, string>>({})
  const [oauthMethodByProvider, setOauthMethodByProvider] = useState<Record<string, number | undefined>>({})
  const [oauthCompletingProvider, setOauthCompletingProvider] = useState<string | null>(null)
  const [providerModelsList, setProviderModelsList] = useState<ProviderModels[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [modelSaving, setModelSaving] = useState(false)
  const [providerEditModes, setProviderEditModes] = useState<Record<string, boolean>>({})

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
        const [settingsResponse, activeRepository] = await Promise.all([
          fetch(`${API_URL}/api/settings`),
          getActiveRepository().catch(() => null),
        ])

        if (settingsResponse.ok) {
          const data = await settingsResponse.json()
          setParallelLimit(data.parallelLimit)
          setMaxBatchSize(data.maxBatchSize ?? 3)
          setQueueAutoApprove(data.queueAutoApprove ?? false)
          setStopOnFailure(data.stopOnFailure ?? false)
          setConflictBehavior(data.conflictBehavior ?? "skip")
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
        const { accent, hover } = JSON.parse(stored)
        setAccentColor(accent)
        document.documentElement.style.setProperty("--linear-accent", accent)
        document.documentElement.style.setProperty("--linear-accent-hover", hover)
      }
    } catch {
    }
  }, [])

  const fetchProviderStatus = async () => {
    setProvidersLoading(true)
    setProviderError(null)
    try {
      await ensureContainer()
      const [status, authMethods, modelsData, modelConfig] = await Promise.all([
        getSetupStatus(),
        getProviderAuthMethods().catch(() => ({} as ProviderAuthMethods)),
        getModels().catch(() => ({ providers: [] as ProviderModels[] })),
        getModelConfig().catch(() => ({ model: null, small_model: null })),
      ])
      setProviderSetupStatus(status)
      setProviderAuthMethodsMap(authMethods)
      setProviderModelsList(modelsData.providers)
      setCurrentModel(modelConfig.model)

      const inputs: Record<string, { key: string; saving: boolean; saved: boolean }> = {}
      status.providers.forEach((provider) => {
        inputs[provider.id] = { key: "", saving: false, saved: false }
      })
      setProviderInputs(inputs)
      setProviderEditModes((prev) => {
        const next: Record<string, boolean> = {}
        status.providers.forEach((provider) => {
          next[provider.id] = prev[provider.id] ?? false
        })
        return next
      })
    } catch (error) {
      console.error("Failed to fetch provider status:", error)
      setProviderError(
        error instanceof Error
          ? error.message
          : "Failed to connect to the AI container. Make sure Docker is running."
      )
    } finally {
      setProvidersLoading(false)
    }
  }

  useEffect(() => {
    if (activeSection !== "ai-providers") return
    fetchProviderStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSection])

  const handleSave = async () => {
    const trimmedBaseBranch = prBaseBranch.trim()

    if (activeRepositoryId && !trimmedBaseBranch) {
      toast.error("PR base branch cannot be empty")
      return
    }

    setSaving(true)
    try {
      const settingsResponse = await fetch(`${API_URL}/api/settings`, {
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

      if (!settingsResponse.ok) {
        toast.error("Failed to save settings")
        return
      }

      if (
        activeRepositoryId &&
        trimmedBaseBranch &&
        trimmedBaseBranch !== savedPrBaseBranch
      ) {
        const updatedRepository = await setActiveRepositoryBaseBranch(trimmedBaseBranch)
        setPrBaseBranch(updatedRepository.defaultBranch)
        setSavedPrBaseBranch(updatedRepository.defaultBranch)
        setActiveRepositoryName(updatedRepository.fullName)
      }

      toast.success("Settings saved successfully")
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

  const handleSaveProviderKey = async (providerId: string) => {
    const input = providerInputs[providerId]
    if (!input?.key.trim()) return

    setProviderInputs((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], saving: true, saved: false },
    }))

    try {
      await setProviderApiKey(providerId, input.key)
      addConfiguredProvider(providerId)

      setProviderSetupStatus((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          providers: prev.providers.map((p) =>
            p.id === providerId ? { ...p, authenticated: true } : p
          ),
          ready: true,
        }
      })

      setProviderInputs((prev) => ({
        ...prev,
        [providerId]: { key: "", saving: false, saved: true },
      }))

      toast.success("API key saved successfully")

      getModels()
        .then((data) => setProviderModelsList(data.providers))
        .catch(() => {})

      setTimeout(() => {
        setProviderInputs((prev) => ({
          ...prev,
          [providerId]: prev[providerId]
            ? { ...prev[providerId], saved: false }
            : { key: "", saving: false, saved: false },
        }))
      }, 3000)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save API key"
      toast.error(message)

      setProviderInputs((prev) => ({
        ...prev,
        [providerId]: { ...prev[providerId], saving: false, saved: false },
      }))
    }
  }

  const extractOAuthCode = useCallback((value: string): string | null => {
    const input = value.trim()
    if (!input) return null

    const directMatch = input.match(/^code=([^&]+)/)
    if (directMatch?.[1]) {
      try {
        return decodeURIComponent(directMatch[1])
      } catch {
        return directMatch[1]
      }
    }

    const queryMatch = input.match(/[?&]code=([^&]+)/)
    if (queryMatch?.[1]) {
      try {
        return decodeURIComponent(queryMatch[1])
      } catch {
        return queryMatch[1]
      }
    }

    try {
      const parsed = new URL(input)
      const code = parsed.searchParams.get("code")
      if (code) return code
    } catch {}

    if (!input.includes("://") && input.includes("=")) {
      const rawParams = input.startsWith("?") ? input.slice(1) : input
      const code = new URLSearchParams(rawParams).get("code")
      if (code) return code
    }

    if (/^[A-Za-z0-9._-]{20,}$/.test(input)) return input
    return null
  }, [])

  const clearOAuthPendingState = useCallback((providerId: string) => {
    setOauthCallbackInputs((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    setOauthMethodByProvider((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY)
  }, [])

  const handleOAuthLogin = async (providerId: string, methodIndex?: number) => {
    setOauthLoadingProvider(providerId)
    try {
      const { url } = await oauthAuthorize(providerId, methodIndex)
      if (url) {
        localStorage.removeItem(OAUTH_CALLBACK_STORAGE_KEY)
        localStorage.setItem(
          OAUTH_PENDING_STORAGE_KEY,
          JSON.stringify({
            providerId,
            method: methodIndex,
            timestamp: Date.now(),
          })
        )
        window.open(url, "_blank", "noopener,noreferrer")
        setOauthWaitingProvider(providerId)
        setOauthMethodByProvider((prev) => ({ ...prev, [providerId]: methodIndex }))
        setOauthCallbackInputs((prev) => ({ ...prev, [providerId]: "" }))
        toast.info("After login, copy the callback URL (or code) and paste it below")
      } else {
        toast.error("No OAuth URL returned")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start OAuth"
      toast.error(message)
    } finally {
      setOauthLoadingProvider(null)
    }
  }

  const handleOAuthComplete = useCallback(async (providerId: string, overrideInput?: string) => {
    const input = overrideInput ?? oauthCallbackInputs[providerId] ?? ""
    const code = extractOAuthCode(input)
    if (!code) {
      toast.error("Paste the callback URL with ?code=... or the raw code")
      return
    }

    setOauthCompletingProvider(providerId)
    try {
      const authMethods = providerAuthMethodsMap[providerId] || []
      const fallbackOauthMethod = authMethods.findIndex((item) => item.type === "oauth")
      const resolvedMethod =
        oauthMethodByProvider[providerId] ?? (fallbackOauthMethod >= 0 ? fallbackOauthMethod : 0)

      await oauthCallback(providerId, code, resolvedMethod)
      addConfiguredProvider(providerId)

      const status = await getSetupStatus()
      setProviderSetupStatus(status)
      setProviderEditModes((prev) => {
        const next: Record<string, boolean> = { ...prev, [providerId]: false }
        status.providers.forEach((provider) => {
          if (next[provider.id] === undefined) {
            next[provider.id] = false
          }
        })
        return next
      })

      const providerConnected = status.providers.find(
        (p) => p.id === providerId && p.authenticated
      )

      if (providerConnected) {
        toast.success("Provider connected successfully")
      } else {
        toast.info("OAuth callback submitted. Refresh status may take a few seconds.")
      }

      getModels()
        .then((data) => setProviderModelsList(data.providers))
        .catch(() => {})

      setOauthWaitingProvider(null)
      clearOAuthPendingState(providerId)
      localStorage.removeItem(OAUTH_CALLBACK_STORAGE_KEY)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to complete OAuth"
      toast.error(message)
    } finally {
      setOauthCompletingProvider(null)
    }
  }, [oauthCallbackInputs, oauthMethodByProvider, providerAuthMethodsMap, extractOAuthCode, clearOAuthPendingState])

  useEffect(() => {
    if (!oauthWaitingProvider) return

    const consumeCallbackPayload = (raw: string | null) => {
      if (!raw || oauthCompletingProvider) return

      try {
        const parsed = JSON.parse(raw) as {
          url?: string
          code?: string
          providerId?: string
          method?: number
          timestamp?: number
        }

        const ageMs = parsed.timestamp ? Date.now() - parsed.timestamp : 0
        if (ageMs > 10 * 60 * 1000) return

        const targetProviderId = parsed.providerId || oauthWaitingProvider
        if (!targetProviderId) return

        const value = parsed.url || parsed.code || ""
        if (!extractOAuthCode(value)) return

        if (typeof parsed.method === "number") {
          setOauthMethodByProvider((prev) => ({
            ...prev,
            [targetProviderId]: parsed.method,
          }))
        }

        setOauthWaitingProvider(targetProviderId)

        setOauthCallbackInputs((prev) => ({
          ...prev,
          [targetProviderId]: value,
        }))

        localStorage.removeItem(OAUTH_CALLBACK_STORAGE_KEY)
        void handleOAuthComplete(targetProviderId, value)
      } catch {}
    }

    const onStorage = (event: StorageEvent) => {
      if (event.key !== OAUTH_CALLBACK_STORAGE_KEY) return
      consumeCallbackPayload(event.newValue)
    }

    window.addEventListener("storage", onStorage)
    consumeCallbackPayload(localStorage.getItem(OAUTH_CALLBACK_STORAGE_KEY))

    return () => {
      window.removeEventListener("storage", onStorage)
    }
  }, [oauthWaitingProvider, oauthCompletingProvider, extractOAuthCode, handleOAuthComplete])

  const handleModelSelect = async (modelValue: string) => {
    setModelSaving(true)
    try {
      await setModel(modelValue)
      setCurrentModel(modelValue)
      toast.success("Model updated")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to set model"
      toast.error(message)
    } finally {
      setModelSaving(false)
    }
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
                Add an extra layer of security to your account
              </p>
            </div>
            <Switch
              checked={twoFactor}
              onCheckedChange={setTwoFactor}
            />
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

  const renderAIProviders = () => {
    const providersSorted = providerSetupStatus
      ? [...providerSetupStatus.providers].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      : []
    const connectedProviders = providersSorted.filter((provider) => provider.authenticated)
    const unconfiguredProviders = providersSorted.filter((provider) => !provider.authenticated)

    const maskProviderApiKey = () => "****************"

    const renderProviderCard = (provider: SetupStatus["providers"][number]) => {
      const authMethods = providerAuthMethodsMap[provider.id] || []
      const hasOAuth = authMethods.some((method) => method.type === "oauth")
      const hasApiKey = authMethods.some((method) => method.type === "api")
      const noAuthMethodsReported = authMethods.length === 0
      const showApiKey = hasApiKey || noAuthMethodsReported
      const oauthMethodIndex = authMethods.findIndex((method) => method.type === "oauth")

      const models =
        providerModelsList.find((providerModels) => providerModels.id === provider.id)
          ?.models || []
      const selectedForProvider =
        currentModel?.startsWith(`${provider.id}/`) ? currentModel : ""
      const selectedModelId = selectedForProvider
        ? selectedForProvider.slice(provider.id.length + 1)
        : ""
      const selectedModelName =
        models.find((model) => model.id === selectedModelId)?.name ||
        selectedModelId ||
        "Not selected"

      const isEditingConnected = provider.authenticated && providerEditModes[provider.id]
      const showConnectedSummary = provider.authenticated && !isEditingConnected

      const closeEditMode = () => {
        setProviderEditModes((prev) => ({
          ...prev,
          [provider.id]: false,
        }))
        setOauthWaitingProvider((prev) => (prev === provider.id ? null : prev))
        clearOAuthPendingState(provider.id)
        localStorage.removeItem(OAUTH_CALLBACK_STORAGE_KEY)
        setProviderInputs((prev) => ({
          ...prev,
          [provider.id]: {
            key: "",
            saving: false,
            saved: false,
          },
        }))
      }

      return (
        <Card
          key={provider.id}
          className="bg-linear-bg-secondary border-linear-border"
        >
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-linear-bg-tertiary flex items-center justify-center">
                  <Brain className="w-4 h-4 text-linear-text-secondary" />
                </div>
                <div>
                  <p className="text-sm font-medium text-linear-text">{provider.name}</p>
                  <p className="text-xs text-linear-text-tertiary">{provider.id}</p>
                </div>
              </div>
              {provider.authenticated ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-linear-accent/10 text-linear-accent border border-linear-accent/30">
                  <Check className="w-3 h-3" />
                  Connected
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-linear-text-tertiary bg-linear-bg-tertiary/50 border border-linear-border">
                  Not configured
                </span>
              )}
            </div>

            {showConnectedSummary ? (
              <div className="space-y-3">
                <div className="rounded-md border border-linear-border bg-linear-bg/50 p-3 space-y-2">
                  {showApiKey && (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-linear-text-tertiary">API key</p>
                      <p className="text-xs font-mono text-linear-text-secondary">
                        {maskProviderApiKey()}
                      </p>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-linear-text-tertiary">Selected model</p>
                    <p className="text-xs text-linear-text-secondary truncate">
                      {selectedModelName}
                    </p>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setProviderEditModes((prev) => ({
                        ...prev,
                        [provider.id]: true,
                      }))
                    }
                    className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary h-8 gap-2"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    Edit settings
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {hasOAuth && (
                  <div>
                    {oauthWaitingProvider === provider.id ? (
                      <div className="space-y-2">
                        <p className="text-xs text-linear-text-tertiary">
                          Waiting for OAuth callback... If auto-detection fails, paste the full callback URL (or just the code) below:
                        </p>
                        <Input
                          type="text"
                          placeholder="Paste callback URL or code"
                          value={oauthCallbackInputs[provider.id] || ""}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setOauthCallbackInputs((prev) => ({
                              ...prev,
                              [provider.id]: e.target.value,
                            }))
                          }
                          className="bg-linear-bg border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent h-9"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => handleOAuthComplete(provider.id)}
                            disabled={
                              oauthCompletingProvider === provider.id ||
                              !oauthCallbackInputs[provider.id]?.trim()
                            }
                            className="bg-linear-accent hover:bg-linear-accent-hover text-white h-9 px-4"
                          >
                            {oauthCompletingProvider === provider.id ? (
                              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            ) : (
                              <Check className="w-4 h-4 mr-2" />
                            )}
                            Complete OAuth
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setOauthWaitingProvider(null)
                              clearOAuthPendingState(provider.id)
                              localStorage.removeItem(OAUTH_CALLBACK_STORAGE_KEY)
                            }}
                            className="border-linear-border text-linear-text-secondary h-9"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          handleOAuthLogin(
                            provider.id,
                            oauthMethodIndex >= 0 ? oauthMethodIndex : undefined
                          )
                        }
                        disabled={oauthLoadingProvider === provider.id}
                        className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary h-9 gap-2"
                      >
                        {oauthLoadingProvider === provider.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <ExternalLink className="w-3.5 h-3.5" />
                        )}
                        Login with {provider.name}
                      </Button>
                    )}
                  </div>
                )}

                {hasOAuth && showApiKey && (
                  <div className="flex items-center gap-2 text-xs text-linear-text-tertiary">
                    <div className="flex-1 h-px bg-linear-border" />
                    <span>or use API key</span>
                    <div className="flex-1 h-px bg-linear-border" />
                  </div>
                )}

                {showApiKey && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      type="password"
                      placeholder={
                        provider.authenticated
                          ? "Enter new API key"
                          : "Enter API key"
                      }
                      value={providerInputs[provider.id]?.key || ""}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setProviderInputs((prev) => ({
                          ...prev,
                          [provider.id]: {
                            ...prev[provider.id],
                            key: e.target.value,
                            saved: false,
                          },
                        }))
                      }
                      disabled={providerInputs[provider.id]?.saving}
                      className="flex-1 bg-linear-bg border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent h-9"
                    />
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => handleSaveProviderKey(provider.id)}
                      disabled={
                        providerInputs[provider.id]?.saved ||
                        !providerInputs[provider.id]?.key.trim() ||
                        providerInputs[provider.id]?.saving
                      }
                      className="h-9 px-4 bg-linear-accent hover:bg-linear-accent-hover text-white disabled:opacity-50"
                    >
                      {providerInputs[provider.id]?.saving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : providerInputs[provider.id]?.saved ? (
                        <>
                          <Check className="w-4 h-4 mr-1" />
                          Saved
                        </>
                      ) : (
                        "Save"
                      )}
                    </Button>
                  </div>
                )}

                {provider.authenticated && models.length > 0 && (
                  <div className="pt-2 border-t border-linear-border">
                    <p className="text-xs text-linear-text-tertiary mb-1.5 block">Model</p>
                    <Select
                      value={selectedForProvider}
                      onValueChange={(value) => handleModelSelect(value)}
                      disabled={modelSaving}
                    >
                      <SelectTrigger className="bg-linear-bg border-linear-border text-linear-text h-9">
                        <SelectValue placeholder="Select a model" />
                      </SelectTrigger>
                      <SelectContent className="bg-linear-bg-secondary border-linear-border max-h-60">
                        {models.map((model) => (
                          <SelectItem key={model.id} value={`${provider.id}/${model.id}`}>
                            <div className="flex items-center gap-2">
                              <span>{model.name || model.id}</span>
                              {model.reasoning && (
                                <span className="text-[10px] px-1 py-0.5 rounded bg-linear-accent/10 text-linear-accent">
                                  reasoning
                                </span>
                              )}
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {provider.authenticated && (
                  <div className="flex justify-end pt-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={closeEditMode}
                      className="h-8 text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary"
                    >
                      Done editing
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )
    }

    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-linear-text">AI Providers</h2>
          <p className="text-sm text-linear-text-tertiary mt-1">
            Configure your LLM provider API keys for AI task execution.
          </p>
        </div>

        {providersLoading ? (
          <Card className="bg-linear-bg-secondary border-linear-border">
            <CardContent className="py-12">
              <div className="flex flex-col items-center justify-center gap-3">
                <Loader2 className="w-6 h-6 animate-spin text-linear-accent" />
                <p className="text-sm text-linear-text-secondary">
                  Starting AI container&hellip;
                </p>
              </div>
            </CardContent>
          </Card>
        ) : providerError ? (
          <Card className="bg-linear-bg-secondary border-red-500/20">
            <CardContent className="py-10">
              <div className="flex flex-col items-center justify-center gap-4">
                <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center">
                  <AlertCircle className="w-5 h-5 text-red-400" />
                </div>
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-linear-text">
                    Failed to load providers
                  </p>
                  <p className="text-xs text-linear-text-tertiary max-w-sm">
                    {providerError}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={fetchProviderStatus}
                  className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-2" />
                  Retry
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : !providerSetupStatus ? (
          <Card className="bg-linear-bg-secondary border-linear-border">
            <CardContent className="py-10">
              <div className="flex flex-col items-center justify-center gap-3">
                <Brain className="w-6 h-6 text-linear-text-tertiary opacity-50" />
                <p className="text-sm text-linear-text-secondary">
                  No provider data available.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : providerSetupStatus.providers.length === 0 ? (
          <Card className="bg-linear-bg-secondary border-linear-border">
            <CardContent className="py-10">
              <div className="flex flex-col items-center justify-center gap-3">
                <Brain className="w-6 h-6 text-linear-text-tertiary opacity-50" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-linear-text">
                    No providers found
                  </p>
                  <p className="text-xs text-linear-text-tertiary">
                    The AI container is running but no providers were detected.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-5">
            {connectedProviders.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 px-1">
                  <span className="text-[11px] uppercase tracking-wide font-medium text-linear-text-tertiary">
                    Connected providers
                  </span>
                  <div className="h-px flex-1 bg-linear-border" />
                </div>
                <div className="space-y-3">
                  {connectedProviders.map((provider) => renderProviderCard(provider))}
                </div>
              </div>
            )}

            {unconfiguredProviders.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center gap-3 px-1">
                  <span className="text-[11px] uppercase tracking-wide font-medium text-linear-text-tertiary">
                    {connectedProviders.length > 0
                      ? "Other providers"
                      : "Available providers"}
                  </span>
                  <div className="h-px flex-1 bg-linear-border" />
                </div>
                <div className="space-y-3">
                  {unconfiguredProviders.map((provider) => renderProviderCard(provider))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

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
      case "ai-providers":
        return renderAIProviders()
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
        <nav className="flex-shrink-0 border-b md:border-b-0 md:border-r border-linear-border bg-linear-bg overflow-x-auto md:overflow-y-auto md:w-52 py-2 md:py-3 px-2 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
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
          <div className="max-w-2xl pb-8">{renderContent()}</div>
        </main>
      </div>
    </AppShell>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen bg-linear-bg"><Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" /></div>}>
      <SettingsContent />
    </Suspense>
  )
}
