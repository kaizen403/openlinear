"use client"

import { useState, useEffect } from "react"
import { Cpu, Loader2 } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getModels, getModelConfig, setModel, type ProviderModels } from "@/lib/api/opencode"

export function ModelSelector() {
  const [modelsList, setModelsList] = useState<ProviderModels[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [modelsData, configData] = await Promise.all([
          getModels(),
          getModelConfig()
        ])
        setModelsList(modelsData.providers || [])
        setCurrentModel(configData.model)
      } catch (err) {
        console.error("Failed to load models:", err)
      } finally {
        setIsLoading(false)
      }
    }
    load()
  }, [])

  const handleSelect = async (val: string) => {
    setCurrentModel(val)
    try {
      await setModel(val)
    } catch (err) {
      console.error("Failed to set model:", err)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 min-w-[132px] sm:min-w-0 flex-1 snap-start">
        <Cpu className="w-3 h-3 flex-shrink-0 text-linear-text-tertiary" />
        <div className="min-w-0 flex-1">
          <div className="text-[9px] uppercase tracking-[0.14em] text-linear-text-tertiary leading-tight">
            Model
          </div>
          <div className="text-[12px] font-medium truncate leading-tight text-linear-text-tertiary flex items-center gap-1">
            <Loader2 className="w-3 h-3 animate-spin" /> Loading...
          </div>
        </div>
      </div>
    )
  }

  const allModels = modelsList.flatMap(p => p.models)
  const selectedModelObj = allModels.find(m => `${m.provider}/${m.id}` === currentModel)

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 min-w-[132px] sm:min-w-0 flex-1 snap-start">
      <Cpu className="w-3 h-3 flex-shrink-0 text-linear-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="text-[9px] uppercase tracking-[0.14em] text-linear-text-tertiary leading-tight">
          Model
        </div>
        <Select value={currentModel || ""} onValueChange={handleSelect}>
          <SelectTrigger className="h-4 p-0 border-0 bg-transparent hover:bg-transparent focus:ring-0 text-[12px] font-medium text-linear-text shadow-none w-full flex items-center justify-between [&>svg]:w-3 [&>svg]:h-3 [&>svg]:opacity-50">
            <SelectValue placeholder="Select Model">
              <span className="truncate block leading-tight">{selectedModelObj ? selectedModelObj.name : "Not set"}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent className="bg-linear-bg-secondary border-linear-border min-w-[200px] max-h-[300px]">
            {modelsList.map(provider => (
              <div key={provider.id}>
                <div className="px-2 py-1.5 text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider bg-linear-bg">
                  {provider.name}
                </div>
                {provider.models.map(m => (
                  <SelectItem key={`${provider.id}/${m.id}`} value={`${provider.id}/${m.id}`} className="text-sm cursor-pointer hover:bg-linear-bg-tertiary">
                    <div className="flex items-center gap-2">
                      <span>{m.name}</span>
                      {m.reasoning && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-purple-500/10 text-purple-400">reasoning</span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </div>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
