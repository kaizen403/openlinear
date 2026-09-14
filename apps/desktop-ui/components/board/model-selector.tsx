"use client"

import { useState, useCallback } from "react"
import { Cpu, Loader2, Check, ChevronDown, Sparkles } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectSeparator,
} from "@/components/ui/select"
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
  const [isOpen, setIsOpen] = useState(false)

  const load = useCallback(async () => {
    if (modelSelectorCache) {
      setModelsList(modelSelectorCache.modelsList)
      setCurrentModel(modelSelectorCache.currentModel)
      return
    }
    setIsLoading(true)
    try {
      const data = await loadModelSelectorData()
      setModelsList(data.modelsList)
      setCurrentModel(data.currentModel)
    } catch (err) {
      console.error("Failed to load models:", err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handleSelect = useCallback(async (val: string) => {
    setCurrentModel(val)
    setIsOpen(false)
    try {
      await setModel(val)
    } catch (err) {
      console.error("Failed to set model:", err)
    }
  }, [])

  const handleOpenChange = useCallback((open: boolean) => {
    setIsOpen(open)
    if (open) void load()
  }, [load])

  const allModels = modelsList.flatMap(p => p.models.map(m => ({ ...m, provider: p.id, providerName: p.name })))
  const selectedModelObj = allModels.find(m => `${m.provider}/${m.id}` === currentModel)

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 min-w-[340px] shrink-0 snap-start">
        <Cpu className="w-3.5 h-3.5 flex-shrink-0 text-linear-text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-[0.14em] text-linear-text-tertiary leading-tight font-medium">
            Model
          </div>
          <div className="text-[12px] font-medium whitespace-nowrap leading-tight text-linear-text-tertiary flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading...
          </div>
        </div>
      </div>
    )
  }


  return (
    <div className="flex items-center gap-2 px-3 py-1.5 min-w-[340px] shrink-0 snap-start">
      <Cpu className="w-3.5 h-3.5 flex-shrink-0 text-linear-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-[0.14em] text-linear-text-tertiary leading-tight font-medium">
          Model
        </div>
        <Select
          value={currentModel || ""}
          onValueChange={handleSelect}
          open={isOpen}
          onOpenChange={handleOpenChange}
        >
          <SelectTrigger
            className={cn(
              "h-auto p-0 border-0 bg-transparent hover:bg-transparent focus:ring-0",
              "text-[12px] font-medium text-linear-text shadow-none w-full",
              "flex items-center justify-between gap-1",
              "[&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-60 [&>svg]:transition-opacity",
              "cursor-pointer select-none",
              isOpen && "[&>svg]:opacity-100 [&>svg]:rotate-180"
            )}
          >
            <SelectValue placeholder="Select Model">
              <span
                className="block leading-tight whitespace-nowrap"
                title={selectedModelObj ? selectedModelObj.name : "Not set"}
              >
                {selectedModelObj ? selectedModelObj.name : "Not set"}
              </span>
            </SelectValue>
          </SelectTrigger>

          <SelectContent
            className={cn(
              "bg-linear-bg-secondary border-linear-border min-w-[280px] max-h-[400px]",
              "shadow-elevation rounded-lg p-0 overflow-hidden",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
              "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
              "data-[side=bottom]:slide-in-from-top-2",
              "transition-all duration-200 ease-out"
            )}
            position="popper"
            sideOffset={4}
          >
            <div className="px-3 py-2 border-b border-linear-border">
              <div className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5 text-linear-accent" />
                <span className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary font-semibold">
                  AI Models
                </span>
              </div>
            </div>

            <div className="py-1">
              {isLoading ? (
                <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-linear-text-tertiary">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading models...
                </div>
              ) : modelsList.length === 0 ? (
                <div className="px-3 py-2 text-[13px] text-linear-text-tertiary">
                  No models available
                </div>
              ) : modelsList.map((provider, providerIndex) => (
                <div key={provider.id}>
                  {providerIndex > 0 && (
                    <SelectSeparator className="bg-linear-border my-1" />
                  )}

                  <div className="px-3 py-1.5">
                    <span className="text-[10px] uppercase tracking-[0.12em] text-linear-text-tertiary font-semibold">
                      {provider.name}
                    </span>
                  </div>

                  {provider.models.map((model) => {
                    const modelValue = `${provider.id}/${model.id}`
                    const isSelected = modelValue === currentModel

                    return (
                      <SelectItem
                        key={modelValue}
                        value={modelValue}
                        className={cn(
                          "relative flex items-center gap-2 px-3 py-2 mx-1 rounded-md",
                          "text-[13px] text-linear-text cursor-pointer",
                          "transition-colors duration-150 ease-out",
                          "focus:bg-linear-bg-tertiary focus:text-linear-text",
                          "data-[highlighted]:bg-linear-bg-tertiary data-[highlighted]:text-linear-text",
                          "hover:bg-linear-bg-tertiary",
                          "outline-none select-none"
                        )}
                      >
                        <div className={cn(
                          "flex items-center justify-center w-4 h-4 flex-shrink-0",
                          "transition-opacity duration-150",
                          isSelected ? "opacity-100" : "opacity-0"
                        )}>
                          <Check className="w-3.5 h-3.5 text-linear-accent" strokeWidth={2.5} />
                        </div>

                        <span
                          className="flex-1 truncate font-medium"
                          title={model.name}
                        >
                          {model.name}
                        </span>

                        {model.reasoning && (
                          <span className={cn(
                            "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium",
                            "bg-linear-accent/15 text-linear-accent border border-linear-accent/20",
                            "flex-shrink-0 tracking-wide"
                          )}>
                            reasoning
                          </span>
                        )}
                      </SelectItem>
                    )
                  })}
                </div>
              ))}
            </div>

            <div className="px-3 py-2 border-t border-linear-border flex justify-center">
              <ChevronDown className="w-3.5 h-3.5 text-linear-text-tertiary opacity-60" />
            </div>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
