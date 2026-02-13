"use client"

import { useState, useEffect, useCallback } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Loader2, Check, AlertCircle, Key } from "lucide-react"
import { ensureContainer, getSetupStatus, setProviderApiKey, ProviderInfo, SetupStatus } from "@/lib/api/opencode"
import { toast } from "sonner"

interface ProviderSetupDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSetupComplete?: () => void
}

interface ProviderInputState {
  key: string
  saving: boolean
  saved: boolean
}

export function ProviderSetupDialog({ open, onOpenChange, onSetupComplete }: ProviderSetupDialogProps) {
  const [loading, setLoading] = useState(true)
  const [containerStarting, setContainerStarting] = useState(true)
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null)
  const [providerInputs, setProviderInputs] = useState<Record<string, ProviderInputState>>({})

  const loadSetupStatus = useCallback(async () => {
    try {
      const status = await getSetupStatus()
      setSetupStatus(status)
      
      const inputs: Record<string, ProviderInputState> = {}
      status.providers.forEach((provider) => {
        inputs[provider.id] = { key: "", saving: false, saved: provider.authenticated }
      })
      setProviderInputs(inputs)
    } catch (err) {
      toast.error("Failed to load provider status")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return

    setLoading(true)
    setContainerStarting(true)
    
    ensureContainer()
      .then(() => {
        setContainerStarting(false)
        return loadSetupStatus()
      })
      .catch(() => {
        toast.error("Failed to start AI environment")
        setContainerStarting(false)
        setLoading(false)
      })
  }, [open, loadSetupStatus])

  const handleSaveKey = async (providerId: string) => {
    const input = providerInputs[providerId]
    if (!input?.key.trim()) return

    setProviderInputs((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], saving: true },
    }))

    try {
      await setProviderApiKey(providerId, input.key)
      
      setProviderInputs((prev) => ({
        ...prev,
        [providerId]: { key: "", saving: false, saved: true },
      }))
      
      toast.success("API key saved")
      
      const status = await getSetupStatus()
      setSetupStatus(status)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save API key"
      toast.error(message)
      
      setProviderInputs((prev) => ({
        ...prev,
        [providerId]: { ...prev[providerId], saving: false },
      }))
    }
  }

  const handleKeyChange = (providerId: string, value: string) => {
    setProviderInputs((prev) => ({
      ...prev,
      [providerId]: { ...prev[providerId], key: value, saved: false },
    }))
  }

  const handleContinue = () => {
    onOpenChange(false)
    onSetupComplete?.()
  }

  const hasConfiguredProvider = setupStatus?.providers.some((p) => p.authenticated) ?? false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] bg-linear-bg-secondary border-linear-border">
        <DialogHeader>
          <DialogTitle className="text-linear-text flex items-center gap-2">
            <Key className="w-5 h-5" />
            Configure AI Providers
          </DialogTitle>
          <DialogDescription className="text-linear-text-secondary">
            Set up your LLM provider API keys to enable AI task execution.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4">
          {containerStarting || loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-4">
              <Loader2 className="w-8 h-8 animate-spin text-linear-accent" />
              <div className="text-center">
                <p className="text-linear-text font-medium">
                  {containerStarting ? "Setting up your AI environment..." : "Loading providers..."}
                </p>
                <p className="text-sm text-linear-text-tertiary mt-1">
                  {containerStarting ? "This may take a moment" : "Fetching available providers"}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {setupStatus?.providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  input={providerInputs[provider.id]}
                  onKeyChange={(value) => handleKeyChange(provider.id, value)}
                  onSave={() => handleSaveKey(provider.id)}
                />
              ))}

              {setupStatus?.providers.length === 0 && (
                <div className="text-center py-8 text-linear-text-secondary">
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No providers available</p>
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
          {hasConfiguredProvider && (
            <Button
              onClick={handleContinue}
              className="bg-linear-accent hover:bg-linear-accent-hover text-white"
            >
              Continue
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ProviderRowProps {
  provider: ProviderInfo
  input: ProviderInputState | undefined
  onKeyChange: (value: string) => void
  onSave: () => void
}

function ProviderRow({ provider, input, onKeyChange, onSave }: ProviderRowProps) {
  if (!input) return null

  return (
    <div className="p-4 rounded-lg bg-linear-bg border border-linear-border">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-linear-text">{provider.name}</span>
        <StatusBadge authenticated={provider.authenticated} />
      </div>
      
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="Enter API key"
          value={input.key}
          onChange={(e) => onKeyChange(e.target.value)}
          disabled={input.saving}
          className="flex-1 bg-linear-bg-secondary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus-visible:ring-linear-accent"
        />
        <Button
          size="sm"
          onClick={onSave}
          disabled={!input.key.trim() || input.saving || input.saved}
          className="bg-linear-accent hover:bg-linear-accent-hover text-white disabled:opacity-50"
        >
          {input.saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : input.saved ? (
            <Check className="w-4 h-4" />
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  )
}

function StatusBadge({ authenticated }: { authenticated: boolean }) {
  if (authenticated) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400 border border-green-500/30">
        <Check className="w-3 h-3" />
        Configured
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-linear-bg-tertiary text-linear-text-tertiary border border-linear-border">
      <AlertCircle className="w-3 h-3" />
      Not configured
    </span>
  )
}
