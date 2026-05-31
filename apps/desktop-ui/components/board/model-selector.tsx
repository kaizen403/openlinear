"use client"

import { useState, useCallback, useMemo } from "react"
import { Cpu, Loader2, Check, ChevronDown, Sparkles } from "lucide-react"
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover"
import { getModels, getModelConfig, setModel, type ProviderModels } from "@/lib/api/opencode"
import { cn } from "@/lib/utils"

let modelSelectorCache: { modelsList: ProviderModels[]; currentModel: string | null } | null = null
let modelSelectorRequest: Promise<{ modelsList: ProviderModels[]; currentModel: string | null }> | null = null

async function loadModelSelectorData(): Promise<{ modelsList: ProviderModels[]; currentModel: string | null }> {
  if (modelSelectorCache) return modelSelectorCache
  modelSelectorRequest ??= Promise.all([
    getModels(),
    getModelConfig(),
  ])
    .then(([modelsData, configData]) => {
      modelSelectorCache = {
        modelsList: modelsData.providers || [],
        currentModel: configData.model,
      }
      return modelSelectorCache
    })
    .finally(() => {
      modelSelectorRequest = null
    })
  return modelSelectorRequest
}

export function ModelSelector() {
  const [modelsList, setModelsList] = useState<ProviderModels[]>(modelSelectorCache?.modelsList ?? [])
  const [currentModel, setCurrentModel] = useState<string | null>(modelSelectorCache?.currentModel ?? null)
  const [isLoading, setIsLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (modelSelectorCache) {
      setModelsList(modelSelectorCache.modelsList)
      setCurrentModel(modelSelectorCache.currentModel)
      // Auto-select the provider of the current model
      const provider = modelSelectorCache.modelsList.find(p =>
        p.models.some(m => `${p.id}/${m.id}` === modelSelectorCache?.currentModel)
      )
      setActiveProviderId(provider?.id ?? modelSelectorCache.modelsList[0]?.id ?? null)
      return
    }
    setIsLoading(true)
    try {
      const data = await loadModelSelectorData()
      setModelsList(data.modelsList)
      setCurrentModel(data.currentModel)
      const provider = data.modelsList.find(p =>
        p.models.some(m => `${p.id}/${m.id}` === data.currentModel)
      )
      setActiveProviderId(provider?.id ?? data.modelsList[0]?.id ?? null)
    } catch (err) {
      console.error("Failed to load models:", err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) void load()
  }, [load])

  const handleSelectModel = useCallback(async (providerId: string, modelId: string) => {
    const value = `${providerId}/${modelId}`
    setCurrentModel(value)
    setOpen(false)
    try {
      await setModel(value)
    } catch (err) {
      console.error("Failed to set model:", err)
    }
  }, [])

  const allModels = useMemo(() =>
    modelsList.flatMap(p => p.models.map(m => ({ ...m, provider: p.id, providerName: p.name }))),
    [modelsList]
  )

  const selectedModelObj = allModels.find(m => `${m.provider}/${m.id}` === currentModel)
  const activeProvider = modelsList.find(p => p.id === activeProviderId)

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 min-w-[260px] shrink-0 snap-start">
      <Cpu className="w-3.5 h-3.5 flex-shrink-0 text-linear-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-[0.14em] text-linear-text-tertiary leading-tight font-medium">
          Model
        </div>

        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "w-full flex items-center justify-between gap-1 text-left",
                "text-[12px] font-medium text-linear-text",
                "cursor-pointer select-none outline-none",
                "focus-visible:ring-1 focus-visible:ring-linear-accent/40 rounded-sm"
              )}
            >
              <span className="block leading-tight truncate" title={selectedModelObj ? selectedModelObj.name : "Not set"}>
                {isLoading && !selectedModelObj ? (
                  <span className="flex items-center gap-1.5 text-linear-text-tertiary">
                    <Loader2 className="w-3 h-3 animate-spin" /> Loading…
                  </span>
                ) : (
                  selectedModelObj ? selectedModelObj.name : "Not set"
                )}
              </span>
              <ChevronDown
                className={cn(
                  "w-3 h-3 text-linear-text-tertiary flex-shrink-0 transition-transform duration-150",
                  open && "rotate-180"
                )}
              />
            </button>
          </PopoverTrigger>

          <PopoverContent
            align="start"
            sideOffset={6}
            className={cn(
              "w-[320px] p-0 bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg shadow-elevation overflow-hidden",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
              "data-[side=bottom]:slide-in-from-top-2",
              "transition-all duration-200 ease-out"
            )}
          >
            {/* Header */}
            <div className="px-3 py-2.5 border-b border-[#2a2a2a] flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-linear-accent" />
              <span className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary font-semibold">
                AI Models
              </span>
            </div>

            {isLoading ? (
              <div className="flex items-center gap-2 px-3 py-4 text-[13px] text-linear-text-tertiary">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading models…
              </div>
            ) : modelsList.length === 0 ? (
              <div className="px-3 py-4 text-[13px] text-linear-text-tertiary">
                No models available
              </div>
            ) : (
              <>
                {/* Provider tabs */}
                <div className="flex gap-1 px-3 pt-2 pb-1 overflow-x-auto scrollbar-none">
                  {modelsList.map((provider) => {
                    const isActive = provider.id === activeProviderId
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => setActiveProviderId(provider.id)}
                        className={cn(
                          "px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors",
                          "outline-none focus-visible:ring-1 focus-visible:ring-linear-accent/40",
                          isActive
                            ? "bg-linear-accent/15 text-linear-accent"
                            : "text-linear-text-tertiary hover:text-linear-text hover:bg-[#252525]"
                        )}
                      >
                        {provider.name}
                      </button>
                    )
                  })}
                </div>

                {/* Model list for active provider */}
                <div className="py-1 max-h-[280px] overflow-y-auto">
                  {activeProvider ? (
                    activeProvider.models.length === 0 ? (
                      <div className="px-3 py-3 text-[13px] text-linear-text-tertiary">
                        No models for this provider
                      </div>
                    ) : (
                      activeProvider.models.map((model) => {
                        const modelValue = `${activeProvider.id}/${model.id}`
                        const isSelected = modelValue === currentModel

                        return (
                          <button
                            key={modelValue}
                            type="button"
                            onClick={() => handleSelectModel(activeProvider.id, model.id)}
                            className={cn(
                              "w-full flex items-center gap-2 px-3 py-2 mx-1 rounded-md",
                              "text-[13px] text-linear-text cursor-pointer",
                              "transition-colors duration-150",
                              "hover:bg-[#252525]",
                              "outline-none focus-visible:bg-[#252525]",
                              "select-none text-left"
                            )}
                          >
                            <div className={cn(
                              "flex items-center justify-center w-4 h-4 flex-shrink-0",
                              "transition-opacity duration-150",
                              isSelected ? "opacity-100" : "opacity-0"
                            )}>
                              <Check className="w-3.5 h-3.5 text-linear-accent" strokeWidth={2.5} />
                            </div>

                            <span className="flex-1 truncate font-medium" title={model.name}>
                              {model.name}
                            </span>
                          </button>
                        )
                      })
                    )
                  ) : (
                    <div className="px-3 py-3 text-[13px] text-linear-text-tertiary">
                      Select a provider
                    </div>
                  )}
                </div>
              </>
            )}

            {/* Footer scroll hint */}
            {activeProvider && activeProvider.models.length > 6 && (
              <div className="px-3 py-1.5 border-t border-[#2a2a2a] flex justify-center">
                <ChevronDown className="w-3.5 h-3.5 text-linear-text-tertiary opacity-60" />
              </div>
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
