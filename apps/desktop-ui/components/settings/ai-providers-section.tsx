"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
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
  Plug,
  Cpu,
  Trash2,
  Star,
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
  removeProviderAuth,
  SetupStatus,
  ProviderAuthMethod,
  ProviderAuthMethods,
  ProviderModels,
} from "@/lib/api/opencode"

const POPULAR_MODELS = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", providers: ["anthropic", "github", "openrouter", "aws-bedrock"] },
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", providers: ["anthropic", "github", "openrouter", "aws-bedrock"] },
  { id: "gpt-4.1", name: "GPT-4.1", providers: ["openai", "github", "openrouter", "azure"] },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", providers: ["google", "github", "openrouter"] },
  { id: "o3", name: "o3", providers: ["openai", "github", "openrouter"] },
  { id: "deepseek-r1", name: "DeepSeek R1", providers: ["deepseek", "github", "openrouter"] },
  { id: "qwen3-235b-a22b", name: "Qwen 3 235B", providers: ["openrouter"] },
]

type ProviderInputState = {
  key: string
  baseUrl: string
  enterpriseUrl: string
  saving: boolean
  saved: boolean
}

const OAUTH_CALLBACK_STORAGE_KEY = "opencode-oauth-callback"
const OAUTH_PENDING_STORAGE_KEY = "opencode-oauth-pending"
const CODEX_PROVIDER_ID = "openai"

type OAuthMethodOption = {
  index: number
  label: string
}

function getOAuthMethodOptions(authMethods: ProviderAuthMethod[]): OAuthMethodOption[] {
  return authMethods.reduce<OAuthMethodOption[]>((methods, method, index) => {
    if (method.type !== "oauth") return methods

    methods.push({
      index,
      label: method.label?.trim() || "OAuth",
    })

    return methods
  }, [])
}

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
    setOauthWaitingProvider((waitingProvider) =>
      waitingProvider === providerId ? null : waitingProvider
    )
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

  const handleRemoveProvider = useCallback(async (providerId: string, providerName: string) => {
    try {
      await removeProviderAuth(providerId)
      toast.success(`${providerName} removed successfully`)
      void fetchProviderStatus()
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove provider"
      toast.error(message)
    }
  }, [fetchProviderStatus])

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
    handleRemoveProvider,
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
    handleRemoveProvider,
    clearOAuthPendingState,
  } = useAIProviders()

  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)

  const providerQuery = providerSearch.trim().toLowerCase()

  const connectedProviders = useMemo(
    () => providerSetupStatus?.providers.filter((p) => p.authenticated) ?? [],
    [providerSetupStatus],
  )

  const providerModelsById = useMemo(
    () => new Map(providerModelsList.map((provider) => [provider.id, provider])),
    [providerModelsList],
  )

  const favoriteModels = useMemo(
    () =>
      providerModelsList
        .flatMap((provider) =>
          provider.models
            .filter((model) => model.favorite)
            .map((model) => ({
              providerId: provider.id,
              providerName: provider.name,
              model,
              value: `${provider.id}/${model.id}`,
            })),
        )
        .sort((a, b) =>
          (a.model.favoriteRank ?? Number.MAX_SAFE_INTEGER) -
          (b.model.favoriteRank ?? Number.MAX_SAFE_INTEGER),
        ),
    [providerModelsList],
  )

  const visiblePopularModels = useMemo(() => {
    if (!providerQuery) return POPULAR_MODELS
    return POPULAR_MODELS.filter(
      (m) =>
        m.name.toLowerCase().includes(providerQuery) ||
        m.id.toLowerCase().includes(providerQuery) ||
        m.providers.some((p) => p.includes(providerQuery)),
    )
  }, [providerQuery])

  const visibleFavoriteModels = useMemo(() => {
    if (!providerQuery) return favoriteModels
    return favoriteModels.filter(
      ({ providerName, model }) =>
        providerName.toLowerCase().includes(providerQuery) ||
        model.name.toLowerCase().includes(providerQuery) ||
        model.id.toLowerCase().includes(providerQuery),
    )
  }, [favoriteModels, providerQuery])

  const visibleProviders = useMemo(() => {
    if (!providerSetupStatus) return []
    const providers = [...providerSetupStatus.providers]
    const filtered = providerQuery
      ? providers.filter(
          (p) =>
            p.name.toLowerCase().includes(providerQuery) ||
            p.id.toLowerCase().includes(providerQuery),
        )
      : providers
    return filtered.sort((a, b) =>
      a.authenticated === b.authenticated
        ? a.name.localeCompare(b.name)
        : a.authenticated ? -1 : 1,
    )
  }, [providerSetupStatus, providerQuery])

  const getSourcesForModel = useCallback(
    (modelId: string, supportedProviderIds: string[]) => {
      return connectedProviders.filter(
        (p) =>
          supportedProviderIds.includes(p.id) ||
          providerModelsById.get(p.id)?.models.some((m) => m.id === modelId),
      )
    },
    [connectedProviders, providerModelsById],
  )

  const isModelActive = useCallback(
    (modelId: string) => currentModel?.endsWith(`/${modelId}`) ?? false,
    [currentModel],
  )

  const renderModelRow = (
    modelId: string,
    modelName: string,
    supportedProviderIds: string[],
    key: string,
  ) => {
    const active = isModelActive(modelId)
    const sources = getSourcesForModel(modelId, supportedProviderIds)

    return (
      <div key={key} className="flex items-center gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <span className="text-sm text-linear-text">{modelName}</span>
        </div>

        {active && sources.length > 0 && (
          <Select
            value={currentModel ?? ""}
            onValueChange={(value) => handleModelSelect(value)}
            disabled={modelSaving}
          >
            <SelectTrigger className="h-7 w-[140px] shrink-0 border-linear-border bg-linear-bg text-xs text-linear-text">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent className="border-linear-border bg-linear-bg-secondary">
              {sources.map((provider) => (
                <SelectItem key={provider.id} value={`${provider.id}/${modelId}`}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {!active && sources.length === 0 && (
          <span className="text-xs text-linear-text-tertiary">No source</span>
        )}

        <Switch
          checked={active}
          onCheckedChange={(checked) => {
            if (checked && sources.length > 0) {
              handleModelSelect(`${sources[0].id}/${modelId}`)
            }
          }}
          disabled={modelSaving || (!active && sources.length === 0)}
          className="shrink-0"
        />
      </div>
    )
  }

  const renderOAuthCallbackCompletion = (providerId: string) => (
    <>
      <p className="text-xs text-linear-text-tertiary">
        {oauthInstructionsByProvider[providerId] ||
          "Waiting for OAuth callback. Paste the full callback URL or code below if needed."}
      </p>
      <Input
        type="text"
        placeholder="Paste callback URL or code"
        value={oauthCallbackInputs[providerId] || ""}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          setOauthCallbackInputs((prev) => ({
            ...prev,
            [providerId]: e.target.value,
          }))
        }
        className="h-9 border-linear-border bg-linear-bg text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => handleOAuthComplete(providerId)}
          disabled={
            oauthCompletingProvider === providerId ||
            !oauthCallbackInputs[providerId]?.trim()
          }
          className="h-9 bg-linear-accent px-4 text-white hover:bg-linear-accent-hover"
        >
          {oauthCompletingProvider === providerId ? (
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
          onClick={() => clearOAuthPendingState(providerId)}
          className="h-9 border-linear-border text-linear-text-secondary"
        >
          Cancel
        </Button>
      </div>
    </>
  )

  const renderOAuthMethodActions = (
    providerId: string,
    methods: OAuthMethodOption[],
    getLabel: (method: OAuthMethodOption) => string,
  ) => (
    <div className="flex flex-wrap items-center gap-2">
      {methods.map((method) => (
        <Button
          key={`${providerId}-${method.index}`}
          type="button"
          size="sm"
          variant="outline"
          onClick={() => handleOAuthLogin(providerId, method.index)}
          disabled={oauthLoadingProvider === providerId}
          className="h-9 gap-2 border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
        >
          {oauthLoadingProvider === providerId ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          {getLabel(method)}
        </Button>
      ))}
    </div>
  )

  const renderProviderSetup = (providerId: string) => {
    const provider = providerSetupStatus?.providers.find((p) => p.id === providerId)
    if (!provider) return null

    const authMethods = providerAuthMethodsMap[provider.id] || []
    const oauthMethods = getOAuthMethodOptions(authMethods)
    const hasOAuth = oauthMethods.length > 0
    const showApiKey = authMethods.length === 0 || authMethods.some((item) => item.type === "api")
    const isWaiting = oauthWaitingProvider === provider.id

    return (
      <div className="mt-2 space-y-3 rounded-md border border-linear-border bg-linear-bg p-3">
        {hasOAuth && (
          <div className="space-y-2">
            {isWaiting ? (
              renderOAuthCallbackCompletion(provider.id)
            ) : (
              renderOAuthMethodActions(
                provider.id,
                oauthMethods,
                (method) =>
                  oauthMethods.length === 1
                    ? `Login with ${provider.name}`
                    : `Login with ${provider.name}: ${method.label}`,
              )
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

  // --- MAIN RENDER ---

  if (providerError) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-linear-text">AI Providers</h2>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => fetchProviderStatus()}
            disabled={providersLoading}
            className="h-8 gap-2 border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", providersLoading && "animate-spin")} />
            Retry
          </Button>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2.5 text-sm text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {providerError}
        </div>
      </div>
    )
  }

  if (providersLoading && !providerSetupStatus) {
    return (
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-linear-text">AI Providers</h2>
        <div className="flex items-center gap-2 text-sm text-linear-text-tertiary">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading providers...
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-linear-text">AI Providers</h2>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => fetchProviderStatus()}
          disabled={providersLoading}
          className="h-8 w-8 p-0 text-linear-text-secondary hover:text-linear-text"
        >
          <RefreshCw className={cn("h-4 w-4", providersLoading && "animate-spin")} />
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-linear-text-tertiary" />
        <Input
          type="search"
          placeholder="Search models and providers..."
          value={providerSearch}
          onChange={(event) => setProviderSearch(event.target.value)}
          className="h-9 border-linear-border bg-linear-bg pl-9 text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent"
        />
      </div>

      {/* Popular Models */}
      {visiblePopularModels.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-linear-text-tertiary">
            Popular Models
          </h3>
          <div className="divide-y divide-linear-border rounded-md border border-linear-border">
            {visiblePopularModels.map((model) =>
              renderModelRow(model.id, model.name, model.providers, `popular-${model.id}`),
            )}
          </div>
        </section>
      )}

      {/* Favorite Models */}
      {visibleFavoriteModels.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-linear-text-tertiary">
            Favorites
          </h3>
          <div className="divide-y divide-linear-border rounded-md border border-linear-border">
            {visibleFavoriteModels.map((item) =>
              renderModelRow(
                item.model.id,
                item.model.name || item.model.id,
                [item.providerId],
                `fav-${item.value}`,
              ),
            )}
          </div>
        </section>
      )}

      {/* Connect Providers */}
      {visibleProviders.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-linear-text-tertiary">
            Connect Providers
          </h3>
          <div className="divide-y divide-linear-border rounded-md border border-linear-border">
            {visibleProviders.map((provider) => (
              <div key={provider.id} className="px-3 py-2.5">
                <div
                  role="button"
                  tabIndex={0}
                  className="flex w-full items-center gap-3 text-left cursor-pointer"
                  onClick={() => {
                    if (provider.authenticated) return
                    setExpandedProvider(
                      expandedProvider === provider.id ? null : provider.id,
                    )
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      if (provider.authenticated) return
                      setExpandedProvider(
                        expandedProvider === provider.id ? null : provider.id,
                      )
                    }
                  }}
                >
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      provider.authenticated ? "bg-green-500" : "bg-linear-text-tertiary/40",
                    )}
                  />
                  <span className="flex-1 text-sm text-linear-text">{provider.name}</span>
                  {provider.authenticated ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleRemoveProvider(provider.id, provider.name)
                      }}
                      className="h-7 w-7 p-0 text-linear-text-tertiary hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : (
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 text-linear-text-tertiary transition-transform",
                        expandedProvider === provider.id && "rotate-180",
                      )}
                    />
                  )}
                </div>
                {!provider.authenticated && expandedProvider === provider.id && (
                  renderProviderSetup(provider.id)
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
