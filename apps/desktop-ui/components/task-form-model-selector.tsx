"use client"

import { useState, useEffect } from "react"
import { Cpu } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getModels, type ProviderModels } from "@/lib/api/opencode"

interface TaskFormModelSelectorProps {
  value: string | null
  onChange: (value: string | null) => void
}

const DEFAULT_SENTINEL = "__default__"

export function TaskFormModelSelector({ value, onChange }: TaskFormModelSelectorProps) {
  const [providers, setProviders] = useState<ProviderModels[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getModels()
      .then((data) => {
        if (!cancelled) setProviders(data.providers || [])
      })
      .catch((err) => console.error("Failed to load models:", err))
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selectedLabel = (() => {
    if (!value) return "Default"
    for (const p of providers) {
      const m = p.models.find((mm) => `${p.id}/${mm.id}` === value)
      if (m) return m.name
    }
    return value
  })()

  return (
    <Select
      value={value ?? DEFAULT_SENTINEL}
      onValueChange={(v) => onChange(v === DEFAULT_SENTINEL ? null : v)}
    >
      <SelectTrigger className="h-7 w-auto px-2.5 text-xs rounded-sm bg-transparent border-none hover:bg-linear-bg-tertiary text-linear-text-secondary gap-1.5 focus:ring-0 shadow-none">
        <div className="flex items-center gap-1.5">
          <Cpu className="w-3 h-3 text-linear-text-tertiary" />
          <SelectValue>
            <span className="truncate">{isLoading ? "Model" : selectedLabel}</span>
          </SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent className="bg-linear-bg-secondary border-linear-border max-h-[360px]">
        <SelectItem
          value={DEFAULT_SENTINEL}
          className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
        >
          Default
        </SelectItem>
        {providers.map((provider) => (
          <SelectGroup key={provider.id}>
            <SelectSeparator className="bg-linear-border" />
            <SelectLabel className="text-[10px] uppercase tracking-wider text-linear-text-tertiary px-2 py-1">
              {provider.name}
            </SelectLabel>
            {provider.models.map((model) => (
              <SelectItem
                key={`${provider.id}/${model.id}`}
                value={`${provider.id}/${model.id}`}
                className="text-linear-text focus:bg-linear-bg-tertiary focus:text-linear-text text-xs"
              >
                {model.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
