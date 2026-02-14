"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Loader2, Check, AlertCircle, Brain, RefreshCw, Settings } from "lucide-react"
import {
  ensureContainer,
  getSetupStatus,
  getConfiguredProviderIds,
  getModelConfig,
  ProviderInfo,
  SetupStatus,
} from "@/lib/api/opencode"

interface ProviderSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSetupComplete?: () => void
}

const MAX_POLL_ATTEMPTS = 6
const POLL_INTERVAL_MS = 2000

export function ProviderSetupDialog({ open, onOpenChange, onSetupComplete }: ProviderSetupDialogProps) {
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [containerStarting, setContainerStarting] = useState(true)
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [currentModelName, setCurrentModelName] = useState<string | null>(null)
  const pollRef = useRef(false)

  const applyProviderData = useCallback((status: SetupStatus) => {
    const cachedIds = new Set(getConfiguredProviderIds())
    const merged = status.providers.map((p) =>
      cachedIds.has(p.id) ? { ...p, authenticated: true } : p
    )
    const sorted = [...merged].sort((a, b) => {
      if (a.authenticated === b.authenticated) return 0
      return a.authenticated ? -1 : 1
    })
    setSetupStatus({ ...status, providers: sorted })

    const firstConfigured = sorted.find((p) => p.authenticated)
    if (firstConfigured) {
      setSelectedProvider(firstConfigured.id)
    }
  }, [])

  const loadWithPolling = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    pollRef.current = true

    try {
      for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
        if (!pollRef.current) return

        const status = await getSetupStatus()

        if (status.providers.length > 0) {
          applyProviderData(status)
          setLoading(false)
          return
        }

        if (attempt < MAX_POLL_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
        }
      }

      const status = await getSetupStatus()
      applyProviderData(status)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load provider status")
    } finally {
      setLoading(false)
    }
  }, [applyProviderData])

  useEffect(() => {
    if (!open) {
      pollRef.current = false
      return
    }

    setLoading(true)
    setContainerStarting(true)
    setLoadError(null)
    setSelectedProvider(null)

    ensureContainer()
      .then(() => {
        setContainerStarting(false)
        getModelConfig()
          .then((cfg) => {
            if (cfg.model) setCurrentModelName(cfg.model)
          })
          .catch(() => {})
        return loadWithPolling()
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Failed to start AI environment")
        setContainerStarting(false)
        setLoading(false)
      })

    return () => {
      pollRef.current = false
    }
  }, [open, loadWithPolling])

  const handleRetry = () => {
    setContainerStarting(true)
    setLoadError(null)
    setLoading(true)

    ensureContainer()
      .then(() => {
        setContainerStarting(false)
        return loadWithPolling()
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : "Failed to start AI environment")
        setContainerStarting(false)
        setLoading(false)
      })
  }

  const handleUse = () => {
    if (!selectedProvider) return
    const provider = setupStatus?.providers.find((p) => p.id === selectedProvider)
    if (!provider?.authenticated) return

    onOpenChange(false)
    onSetupComplete?.()
  }

  const handleGoToSettings = () => {
    onOpenChange(false)
    router.push("/settings?section=ai-providers")
  }

  const configuredProviders = setupStatus?.providers.filter((p) => p.authenticated) ?? []
  const hasConfigured = configuredProviders.length > 0
  const canUse = selectedProvider !== null && configuredProviders.some((p) => p.id === selectedProvider)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] max-h-[85vh] flex flex-col bg-linear-bg-secondary border-linear-border">
        <DialogHeader>
          <DialogTitle className="text-linear-text flex items-center gap-2">
            <Brain className="w-5 h-5" />
            Select AI Provider
          </DialogTitle>
          <DialogDescription className="text-linear-text-secondary">
            {hasConfigured
              ? "Choose a provider to run this task."
              : "No providers configured yet. Set one up in Settings."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto py-2 min-h-0">
          {containerStarting || loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-linear-accent" />
              <div className="text-center">
                <p className="text-linear-text font-medium">
                  {containerStarting ? "Setting up your AI environment..." : "Loading providers..."}
                </p>
                <p className="text-sm text-linear-text-tertiary mt-1">
                  {containerStarting ? "This may take a moment" : "Detecting available providers"}
                </p>
              </div>
            </div>
          ) : loadError ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <AlertCircle className="w-8 h-8 text-red-400" />
              <div className="text-center">
                <p className="text-sm font-medium text-linear-text">Failed to load providers</p>
                <p className="text-xs text-linear-text-tertiary mt-1">{loadError}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={handleRetry}
                className="border-linear-border text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <button
                onClick={handleGoToSettings}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-linear-text-secondary hover:text-linear-text bg-linear-bg border border-dashed border-linear-border hover:border-linear-text-tertiary transition-colors"
              >
                <Settings className="w-4 h-4" />
                Configure providers in Settings
              </button>

              {configuredProviders.map((provider) => {
                const modelForProvider = currentModelName?.startsWith(`${provider.id}/`)
                  ? currentModelName.slice(provider.id.length + 1)
                  : undefined
                return (
                  <ProviderRow
                    key={provider.id}
                    provider={provider}
                    selected={selectedProvider === provider.id}
                    onSelect={() => setSelectedProvider(provider.id)}
                    activeModel={modelForProvider}
                  />
                )
              })}

              {configuredProviders.length === 0 && (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <AlertCircle className="w-8 h-8 text-linear-text-tertiary opacity-50" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-linear-text-secondary">No providers configured</p>
                    <p className="text-xs text-linear-text-tertiary mt-1">
                      Add a provider in Settings to get started.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-linear-border text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary"
          >
            Cancel
          </Button>
          <Button
            onClick={handleUse}
            disabled={!canUse}
            className="bg-linear-accent hover:bg-linear-accent-hover text-white disabled:opacity-50"
          >
            Use
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ProviderRowProps {
  provider: ProviderInfo
  selected: boolean
  onSelect: () => void
  activeModel?: string
}

function ProviderRow({ provider, selected, onSelect, activeModel }: ProviderRowProps) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer ${
        selected
          ? "bg-linear-bg border border-linear-accent ring-1 ring-linear-accent/30"
          : "bg-linear-bg border border-linear-border hover:border-linear-text-tertiary"
      }`}
      onClick={onSelect}
    >
      <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0 ${
        selected ? "border-linear-accent" : "border-linear-text-tertiary"
      }`}>
        {selected && <div className="w-2 h-2 rounded-full bg-linear-accent" />}
      </div>
      <div className="w-7 h-7 rounded-md bg-linear-bg-tertiary flex items-center justify-center flex-shrink-0">
        <Brain className="w-3.5 h-3.5 text-linear-text-secondary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-linear-text truncate">{provider.name}</p>
        {activeModel && (
          <p className="text-xs text-linear-text-tertiary truncate">Using: {activeModel}</p>
        )}
      </div>
      {provider.authenticated ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-green-500/10 text-green-400 border border-green-500/20 flex-shrink-0">
          <Check className="w-3 h-3" />
          Ready
        </span>
      ) : (
        <span className="text-[11px] text-linear-text-tertiary flex-shrink-0">
          Not configured
        </span>
      )}
    </div>
  )
}
