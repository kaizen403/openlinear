"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Brain, Check, Loader2, Rocket, Settings, AlertCircle, ExternalLink } from "lucide-react"
import { toast } from "sonner"
import {
  getSetupStatus,
  OpenCodeUnavailableError,
  type SetupStatus,
  type ProviderInfo,
} from "@/lib/api/opencode"

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; status: SetupStatus }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string }

interface ModelProviderStepProps {
  isFinishing: boolean
  onBack: () => void
  onFinish: () => void
  onSkip: () => void
}

export function ModelProviderStep({
  isFinishing,
  onBack,
  onFinish,
  onSkip,
}: ModelProviderStepProps) {
  const router = useRouter()
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setState({ kind: "loading" })
      try {
        const status = await getSetupStatus()
        if (!cancelled) {
          setState({ kind: "ready", status })
        }
      } catch (err) {
        if (cancelled) return
        if (err instanceof OpenCodeUnavailableError) {
          setState({
            kind: "unavailable",
            message:
              "The execution sidecar is not running yet. You can finish onboarding and configure a provider later.",
          })
          return
        }
        const message =
          err instanceof Error ? err.message : "Could not load AI provider status"
        setState({ kind: "error", message })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [refreshTick])

  const handleOpenSettings = () => {
    router.push("/settings?section=ai-providers")
  }

  const isReady = state.kind === "ready" && state.status.ready
  const hasProvider = state.kind === "ready" && Boolean(state.status.hasProvider)

  return (
    <div className="space-y-4">
      <div className="text-center space-y-1.5">
        <div className="w-10 h-10 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-2">
          <Brain className="w-5 h-5 text-linear-accent" />
        </div>
        <h2 className="text-lg font-semibold text-linear-text">Pick an AI model</h2>
        <p className="text-xs text-linear-text-secondary">
          Connect a provider so OpenLinear can execute tasks. You can skip this and set it up later.
        </p>
      </div>

      <StatusBody
        state={state}
        onRefresh={() => setRefreshTick((tick) => tick + 1)}
        onOpenSettings={handleOpenSettings}
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={isFinishing}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-9 px-4 text-sm font-medium transition-colors disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => {
            if (isReady) {
              onFinish()
            } else if (hasProvider) {
              toast.error("Pick a model in Settings first, or Skip to finish without one.")
            } else {
              toast.error("Connect a provider in Settings first, or Skip to finish without one.")
            }
          }}
          disabled={isFinishing || !isReady}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-9 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isFinishing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Finishing...
            </>
          ) : (
            <>
              <Rocket className="w-4 h-4" />
              Finish setup
            </>
          )}
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={isFinishing}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text-secondary hover:text-linear-text rounded-sm h-9 px-4 text-sm font-medium transition-colors disabled:opacity-50"
        >
          Skip
        </button>
      </div>
    </div>
  )
}

interface StatusBodyProps {
  state: LoadState
  onRefresh: () => void
  onOpenSettings: () => void
}

function StatusBody({ state, onRefresh, onOpenSettings }: StatusBodyProps) {
  if (state.kind === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-xs text-linear-text-tertiary">
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking AI providers...
      </div>
    )
  }

  if (state.kind === "unavailable") {
    return (
      <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary px-3 py-3 space-y-2">
        <div className="flex items-start gap-2 text-xs text-linear-text-secondary">
          <AlertCircle className="w-4 h-4 mt-0.5 text-linear-text-tertiary shrink-0" />
          <span>{state.message}</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-linear-accent hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }

  if (state.kind === "error") {
    return (
      <div className="rounded-sm border border-red-500/20 bg-red-500/5 px-3 py-3 space-y-2">
        <div className="flex items-start gap-2 text-xs text-red-300">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{state.message}</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="text-xs text-linear-accent hover:underline"
        >
          Retry
        </button>
      </div>
    )
  }

  const { providers, hasProvider, hasModel, currentModel } = normalizeStatus(state.status)
  const connectedProviders = providers.filter((p) => p.authenticated)

  return (
    <div className="space-y-3">
      {hasProvider && hasModel && currentModel && (
        <div className="rounded-sm border border-linear-accent/30 bg-linear-accent/5 px-3 py-2.5 flex items-center gap-2 text-sm text-linear-text">
          <Check className="w-4 h-4 text-linear-accent shrink-0" />
          <span className="truncate">
            Using <span className="font-medium">{currentModel}</span>
          </span>
        </div>
      )}

      {hasProvider && !hasModel && (
        <div className="rounded-sm border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-200">
          A provider is connected but no model is selected yet. Pick one in Settings.
        </div>
      )}

      {!hasProvider && (
        <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary px-3 py-3 space-y-2">
          <p className="text-xs text-linear-text-secondary">
            No providers connected. Open Settings to sign in with Anthropic, OpenAI, Google, or any
            other supported provider.
          </p>
        </div>
      )}

      {connectedProviders.length > 0 && (
        <div className="rounded-sm border border-linear-border divide-y divide-linear-border overflow-hidden">
          {connectedProviders.map((provider) => (
            <ConnectedProviderRow key={provider.id} provider={provider} />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onOpenSettings}
        className="w-full flex items-center justify-center gap-1.5 text-xs text-linear-accent hover:underline py-1"
      >
        <Settings className="w-3.5 h-3.5" />
        Manage providers in Settings
        <ExternalLink className="w-3 h-3" />
      </button>
    </div>
  )
}

function ConnectedProviderRow({ provider }: { provider: ProviderInfo }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-linear-bg-tertiary">
      <Check className="w-3.5 h-3.5 text-linear-accent shrink-0" />
      <span className="text-sm text-linear-text flex-1 truncate">{provider.name}</span>
      {provider.selectedModel && (
        <span className="text-[11px] text-linear-text-tertiary truncate">
          {provider.selectedModel}
        </span>
      )}
    </div>
  )
}

function normalizeStatus(status: SetupStatus) {
  const providers = status.providers ?? []
  const hasProvider =
    typeof status.hasProvider === "boolean"
      ? status.hasProvider
      : providers.some((p) => p.authenticated)
  const hasModel =
    typeof status.hasModel === "boolean" ? status.hasModel : Boolean(status.currentModel)
  return {
    providers,
    hasProvider,
    hasModel,
    currentModel: status.currentModel ?? null,
  }
}
