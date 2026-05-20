"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Brain,
  Check,
  AlertCircle,
  RefreshCw,
  Search,
  ExternalLink,
  Loader2,
  ChevronDown,
  KeyRound,
  Plug,
  Cpu,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  getSetupStatus,
  setProviderApiKey,
  getProviderAuthMethods,
  oauthAuthorize,
  oauthCallback,
  getModels,
  getModelConfig,
  setModel,
  SetupStatus,
  ProviderAuthMethods,
  ProviderModels,
} from "@/lib/api/opencode"

type ProviderInputState = {
  key: string
  baseUrl: string
  enterpriseUrl: string
  saving: boolean
  saved: boolean
}

const OAUTH_CALLBACK_STORAGE_KEY = "opencode-oauth-callback"
const OAUTH_PENDING_STORAGE_KEY = "opencode-oauth-pending"

function useAIProviders() {
  const [providersLoading, setProvidersLoading] = useState(false)
  const [providerSetupStatus, setProviderSetupStatus] = useState<SetupStatus | null>(null)
  const [providerInputs, setProviderInputs] = useState<Record<string, ProviderInputState>>({})
  const [providerError, setProviderError] = useState<string | null>(null)
  const [providerAuthMethodsMap, setProviderAuthMethodsMap] = useState<ProviderAuthMethods>({})
  const [oauthLoadingProvider, setOauthLoadingProvider] = useState<string | null>(null)
  const [oauthWaitingProvider, setOauthWaitingProvider] = useState<string | null>(null)
  const [oauthCallbackInputs, setOauthCallbackInputs] = useState<Record<string, string>>({})
  const [oauthInstructionsByProvider, setOauthInstructionsByProvider] = useState<Record<string, string>>({})
  const [oauthMethodByProvider, setOauthMethodByProvider] = useState<Record<string, number | undefined>>({})
  const [oauthCompletingProvider, setOauthCompletingProvider] = useState<string | null>(null)
  const [providerModelsList, setProviderModelsList] = useState<ProviderModels[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [modelSaving, setModelSaving] = useState(false)
  const [providerSearch, setProviderSearch] = useState("")

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

    const fallbackMatch = input.match(/code=([^&]+)/)
    if (fallbackMatch?.[1]) {
      try {
        return decodeURIComponent(fallbackMatch[1])
      } catch {
        return fallbackMatch[1]
      }
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
    setOauthInstructionsByProvider((prev) => {
      const next = { ...prev }
      delete next[providerId]
      return next
    })
    localStorage.removeItem(OAUTH_PENDING_STORAGE_KEY)
  }, [])

  const fetchProviderStatus = useCallback(async () => {
    setProvidersLoading(true)
    setProviderError(null)
    try {
      const [status, authMethods, modelsData, modelConfig] = await Promise.all([
        getSetupStatus(),
        getProviderAuthMethods().catch(() => ({} as ProviderAuthMethods)),
        getModels().catch(() => ({ providers: [] as ProviderModels[] })),
        getModelConfig().catch(() => ({ model: null, small_model: null })),
      ])
      setProviderSetupStatus(status)
      const mergedAuthMethods: ProviderAuthMethods = { ...authMethods }
      status.providers.forEach((provider) => {
        if (provider.authMethods && provider.authMethods.length > 0) {
          mergedAuthMethods[provider.id] = provider.authMethods
        }
      })
      setProviderAuthMethodsMap(mergedAuthMethods)
      setProviderModelsList(modelsData.providers)
      setCurrentModel(modelConfig.model ?? status.currentModel ?? null)

      setProviderInputs((prev) => {
        const inputs: Record<string, ProviderInputState> = {}
        status.providers.forEach((provider) => {
          inputs[provider.id] = {
            key: "",
            baseUrl: prev[provider.id]?.baseUrl ?? provider.baseUrl ?? "",
            enterpriseUrl: prev[provider.id]?.enterpriseUrl ?? "",
            saving: false,
            saved: false,
          }
        })
        return inputs
      })
    } catch (error) {
      console.error("Failed to fetch provider status:", error)
      setProviderError(
        error instanceof Error
          ? error.message
          : "Failed to connect to the AI environment. Make sure OpenCode is running."
      )
    } finally {
      setProvidersLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProviderStatus()
  }, [fetchProviderStatus])

  const handleSaveProviderKey = useCallback(async (providerId: string) => {
    const input = providerInputs[providerId]
    if (!input?.key.trim()) return

    setProviderInputs((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], saving: true, saved: false },
    }))

    try {
      await setProviderApiKey(providerId, input.key, {
        baseUrl: input.baseUrl.trim() || undefined,
        enterpriseUrl: input.enterpriseUrl.trim() || undefined,
      })

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
        [providerId]: {
          ...(prev[providerId] ?? { baseUrl: "", enterpriseUrl: "" }),
          key: "",
          saving: false,
          saved: true,
        },
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
            : { key: "", baseUrl: "", enterpriseUrl: "", saving: false, saved: false },
        }))
      }, 3000)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save API key"
      toast.error(message)

      setProviderInputs((prev) => ({
        ...prev,
        [providerId]: {
          ...(prev[providerId] ?? { key: "", baseUrl: "", enterpriseUrl: "" }),
          saving: false,
          saved: false,
        },
      }))
    }
  }, [providerInputs])

  const handleOAuthLogin = useCallback(async (providerId: string, methodIndex?: number) => {
    setOauthLoadingProvider(providerId)
    try {
      const { url, instructions } = await oauthAuthorize(providerId, methodIndex)
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
        setOauthInstructionsByProvider((prev) => ({
          ...prev,
          [providerId]:
            instructions ||
            "Complete the browser sign-in. If OpenCode returns a code flow, paste the callback URL or code below.",
        }))
        toast.info(
          instructions ||
            "Complete the browser sign-in, then paste the callback URL or code if needed"
        )
      } else {
        toast.error("No OAuth URL returned")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start OAuth"
      toast.error(message)
    } finally {
      setOauthLoadingProvider(null)
    }
  }, [])

  const handleOAuthComplete = useCallback(
    async (providerId: string, overrideInput?: string) => {
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
          oauthMethodByProvider[providerId] ??
          (fallbackOauthMethod >= 0 ? fallbackOauthMethod : 0)

        await oauthCallback(providerId, code, resolvedMethod)

        const status = await getSetupStatus()
        setProviderSetupStatus(status)

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
        setOauthInstructionsByProvider((prev) => {
          const next = { ...prev }
          delete next[providerId]
          return next
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to complete OAuth"
        toast.error(message)
      } finally {
        setOauthCompletingProvider(null)
      }
    },
    [oauthCallbackInputs, oauthMethodByProvider, providerAuthMethodsMap, extractOAuthCode, clearOAuthPendingState]
  )

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

  const handleModelSelect = useCallback(async (modelValue: string) => {
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
  }, [])

  return {
    providersLoading,
    providerSetupStatus,
    providerInputs,
    providerError,
    providerAuthMethodsMap,
    oauthLoadingProvider,
    oauthWaitingProvider,
    oauthCallbackInputs,
    oauthInstructionsByProvider,
    oauthMethodByProvider,
    oauthCompletingProvider,
    providerModelsList,
    currentModel,
    modelSaving,
    providerSearch,
    setProviderSearch,
    setProviderInputs,
    setOauthCallbackInputs,
    fetchProviderStatus,
    handleSaveProviderKey,
    handleOAuthLogin,
    handleOAuthComplete,
    handleModelSelect,
    clearOAuthPendingState,
  }
}

export function AIProvidersSection() {
  const {
    providersLoading,
    providerSetupStatus,
    providerInputs,
    providerError,
    providerAuthMethodsMap,
    oauthLoadingProvider,
    oauthWaitingProvider,
    oauthCallbackInputs,
    oauthInstructionsByProvider,
    oauthMethodByProvider,
    oauthCompletingProvider,
    providerModelsList,
    currentModel,
    modelSaving,
    providerSearch,
    setProviderSearch,
    setProviderInputs,
    setOauthCallbackInputs,
    fetchProviderStatus,
    handleSaveProviderKey,
    handleOAuthLogin,
    handleOAuthComplete,
    handleModelSelect,
    clearOAuthPendingState,
  } = useAIProviders()

  const [selectedUnconnectedProvider, setSelectedUnconnectedProvider] = useState<string | null>(null)

  const currentProviderId = currentModel?.split("/")[0] ?? null
  const providerQuery = providerSearch.trim().toLowerCase()

  const providersSorted = providerSetupStatus
    ? [...providerSetupStatus.providers]
        .filter((provider) => {
          if (!providerQuery) return true
          return (
            provider.name.toLowerCase().includes(providerQuery) ||
            provider.id.toLowerCase().includes(providerQuery) ||
            provider.selectedModel?.toLowerCase().includes(providerQuery) ||
            provider.defaultModel?.toLowerCase().includes(providerQuery)
          )
        })
        .sort((a, b) => {
          const aCurrent = currentProviderId === a.id ? 1 : 0
          const bCurrent = currentProviderId === b.id ? 1 : 0
          if (aCurrent !== bCurrent) return bCurrent - aCurrent
          if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1
          return (b.modelCount ?? 0) - (a.modelCount ?? 0) || a.name.localeCompare(b.name)
        })
    : []

  const connectedProviders = providersSorted.filter((provider) => provider.authenticated)
  const unconfiguredProviders = providersSorted.filter((provider) => !provider.authenticated)
  const totalProviders = providerSetupStatus?.providers.length ?? 0
  const totalConnected = providerSetupStatus?.providers.filter((provider) => provider.authenticated).length ?? 0
  const totalModels = providerModelsList.reduce((sum, provider) => sum + provider.models.length, 0)

  const renderConnectedProvider = (provider: SetupStatus["providers"][number]) => {
    const models = providerModelsList.find((item) => item.id === provider.id)?.models ?? []
    const selectedForProvider =
      currentModel?.startsWith(`${provider.id}/`) && currentModel
        ? currentModel
        : provider.selectedModel
          ? `${provider.id}/${provider.selectedModel}`
          : ""

    return (
      <div
        key={provider.id}
        className="flex items-center gap-3 rounded-md border border-linear-border bg-linear-bg-secondary px-3 py-2.5"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-linear-bg-tertiary">
          <Brain className="h-3.5 w-3.5 text-linear-text-secondary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-linear-text">{provider.name}</span>
            {currentProviderId === provider.id && (
              <span className="inline-flex items-center rounded-full border border-linear-accent/20 bg-linear-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-linear-accent">
                Active
              </span>
            )}
          </div>
          <div className="text-xs text-linear-text-tertiary">
            {models.length || provider.modelCount || 0} models
          </div>
        </div>

        {models.length > 0 && (
          <Select
            value={selectedForProvider}
            onValueChange={(value) => handleModelSelect(value)}
            disabled={modelSaving}
          >
            <SelectTrigger className="h-8 w-[200px] shrink-0 border-linear-border bg-linear-bg text-xs text-linear-text">
              <SelectValue placeholder="Select model" />
            </SelectTrigger>
            <SelectContent className="max-h-60 border-linear-border bg-linear-bg-secondary">
              {models.map((model) => (
                <SelectItem key={model.id} value={`${provider.id}/${model.id}`}>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{model.name || model.id}</span>
                    {model.reasoning && (
                      <span className="rounded bg-linear-accent/10 px-1 py-0.5 text-[10px] text-linear-accent">
                        reasoning
                      </span>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    )
  }

  const renderProviderSetup = (providerId: string) => {
    const provider = providerSetupStatus?.providers.find((p) => p.id === providerId)
    if (!provider) return null

    const authMethods = providerAuthMethodsMap[provider.id] || []
    const hasOAuth = authMethods.some((item) => item.type === "oauth")
    const oauthMethodIndex = authMethods.findIndex((item) => item.type === "oauth")
    const showApiKey = authMethods.length === 0 || authMethods.some((item) => item.type === "api")
    const isWaiting = oauthWaitingProvider === provider.id

    return (
      <div className="mt-3 space-y-4 rounded-md border border-linear-border bg-linear-bg-secondary p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-linear-bg-tertiary">
              <Brain className="h-3.5 w-3.5 text-linear-text-secondary" />
            </div>
            <span className="text-sm font-medium text-linear-text">{provider.name}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setSelectedUnconnectedProvider(null)}
            className="h-8 text-linear-text-secondary hover:text-linear-text"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>

        {hasOAuth && (
          <div className="space-y-2">
            {isWaiting ? (
              <>
                <p className="text-xs text-linear-text-tertiary">
                  {oauthInstructionsByProvider[provider.id] ||
                    "Waiting for OAuth callback. Paste the full callback URL or code below if needed."}
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
                  className="h-9 border-linear-border bg-linear-bg text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent"
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
                    className="h-9 bg-linear-accent px-4 text-white hover:bg-linear-accent-hover"
                  >
                    {oauthCompletingProvider === provider.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Check className="mr-2 h-4 w-4" />
                    )}
                    Complete OAuth
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => clearOAuthPendingState(provider.id)}
                    className="h-9 border-linear-border text-linear-text-secondary"
                  >
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  handleOAuthLogin(provider.id, oauthMethodIndex >= 0 ? oauthMethodIndex : undefined)
                }
                disabled={oauthLoadingProvider === provider.id}
                className="h-9 gap-2 border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
              >
                {oauthLoadingProvider === provider.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ExternalLink className="h-3.5 w-3.5" />
                )}
                Login with {provider.name}
              </Button>
            )}
          </div>
        )}

        {hasOAuth && showApiKey && (
          <div className="flex items-center gap-2 text-xs text-linear-text-tertiary">
            <div className="h-px flex-1 bg-linear-border" />
            <span>or use API key</span>
            <div className="h-px flex-1 bg-linear-border" />
          </div>
        )}

        {showApiKey && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type="password"
              placeholder="Enter API key"
              value={providerInputs[provider.id]?.key || ""}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setProviderInputs((prev) => ({
                  ...prev,
                  [provider.id]: {
                    ...(prev[provider.id] ?? {
                      baseUrl: "",
                      enterpriseUrl: "",
                      saving: false,
                      saved: false,
                    }),
                    key: e.target.value,
                    saved: false,
                  },
                }))
              }
              disabled={providerInputs[provider.id]?.saving}
              className="h-9 flex-1 border-linear-border bg-linear-bg text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent"
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
              className="h-9 bg-linear-accent px-4 text-white hover:bg-linear-accent-hover disabled:opacity-50"
            >
              {providerInputs[provider.id]?.saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : providerInputs[provider.id]?.saved ? (
                <>
                  <Check className="mr-1 h-4 w-4" />
                  Saved
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-linear-text">AI Providers</h2>
          <p className="mt-1 text-sm text-linear-text-tertiary">
            {totalConnected} of {totalProviders} connected, {totalModels} models available
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => fetchProviderStatus()}
          disabled={providersLoading}
          className="h-9 gap-2 border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
        >
          <RefreshCw className={cn("h-4 w-4", providersLoading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-linear-text-tertiary" />
        <Input
          type="search"
          placeholder="Search providers"
          value={providerSearch}
          onChange={(event) => setProviderSearch(event.target.value)}
          className="h-9 border-linear-border bg-linear-bg pl-9 text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent"
        />
      </div>

      {providerError && (
        <div className="flex items-center gap-2 rounded-sm border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          <AlertCircle className="h-4 w-4" />
          {providerError}
        </div>
      )}

      {providersLoading && !providerSetupStatus ? (
        <div className="flex items-center gap-2 text-sm text-linear-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading providers...
        </div>
      ) : totalProviders === 0 ? (
        <Card className="border-linear-border bg-linear-bg-secondary">
          <CardContent className="flex items-center gap-3 p-4 text-sm text-linear-text-tertiary">
            <Plug className="h-4 w-4" />
            No providers found.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {connectedProviders.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-linear-accent/10">
                  <Check className="h-3 w-3 text-linear-accent" />
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-linear-text-tertiary">
                  Connected
                </div>
              </div>
              <div className="space-y-2">{connectedProviders.map(renderConnectedProvider)}</div>
            </div>
          )}

          {unconfiguredProviders.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-linear-bg-tertiary">
                  <Cpu className="h-3 w-3 text-linear-text-tertiary" />
                </div>
                <div className="text-xs font-medium uppercase tracking-wide text-linear-text-tertiary">
                  Add Provider
                </div>
              </div>

              <Select
                value={selectedUnconnectedProvider || ""}
                onValueChange={(value) => setSelectedUnconnectedProvider(value)}
              >
                <SelectTrigger className="h-9 border-linear-border bg-linear-bg text-sm text-linear-text">
                  <SelectValue placeholder={`${unconfiguredProviders.length} providers available`} />
                </SelectTrigger>
                <SelectContent className="max-h-60 border-linear-border bg-linear-bg-secondary">
                  {unconfiguredProviders.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      <div className="flex items-center gap-2">
                        <Brain className="h-3.5 w-3.5 text-linear-text-secondary" />
                        <span>{provider.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {selectedUnconnectedProvider && renderProviderSetup(selectedUnconnectedProvider)}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
