"use client"

import { useState, useEffect } from "react"
import { Moon, Sun, Laptop, Check } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useTheme } from "next-themes"
// Presets (brand + contrast-safe solid) live with the design tokens. The
// stored JSON keeps its `{ accent, hover }` shape; `hover` holds the solid.
// Saved choices from before the contrast-safe presets (and the retired blues)
// are migrated by the same table the boot script in app/layout.tsx uses.
import { ACCENT_PRESETS, DEFAULT_ACCENT } from "@/lib/design/accent"
import {
  ACCENT_STORAGE_KEY,
  DEFAULT_ACCENT_CHANNELS,
  accentChannels,
  migrateStoredAccent,
} from "@/lib/design/accent-migration"

function applyAccentVariables(accent: string, hover: string) {
  document.documentElement.style.setProperty("--linear-accent", accent)
  document.documentElement.style.setProperty("--linear-accent-hover", hover)
  document.documentElement.style.setProperty("--linear-accent-rgb", accentChannels(accent, DEFAULT_ACCENT_CHANNELS.accent))
  document.documentElement.style.setProperty("--linear-accent-hover-rgb", accentChannels(hover, DEFAULT_ACCENT_CHANNELS.solid))
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const [compactMode, setCompactMode] = useState(false)
  const [animations, setAnimations] = useState(true)
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT.accent)

  useEffect(() => {
    try {
      const stored = localStorage.getItem(ACCENT_STORAGE_KEY)
      const result = stored ? migrateStoredAccent(JSON.parse(stored)) : null
      if (result) {
        const { accent, hover } = result.value
        if (result.migrated) localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify({ accent, hover }))
        setAccentColor(accent)
        applyAccentVariables(accent, hover)
      }
    } catch {}
  }, [])

  const applyAccentColor = (accent: string, hover: string) => {
    setAccentColor(accent)
    applyAccentVariables(accent, hover)
    try {
      localStorage.setItem(ACCENT_STORAGE_KEY, JSON.stringify({ accent, hover }))
    } catch {}
  }

  return (
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
            {([
              { value: "dark" as const, label: "Dark", icon: Moon, disabled: false },
              { value: "light" as const, label: "Light", icon: Sun, disabled: true },
              { value: "system" as const, label: "System", icon: Laptop, disabled: false },
            ] as const).map((option) => (
              <button
                key={option.value}
                onClick={() => !option.disabled && setTheme(option.value)}
                disabled={option.disabled}
                title={option.disabled ? "Light theme coming soon" : undefined}
                className={`flex flex-col items-center gap-2 p-4 rounded-sm border transition-colors ${
                  option.disabled
                    ? "border-linear-border bg-linear-bg text-linear-text-tertiary opacity-50 cursor-not-allowed"
                    : theme === option.value
                    ? "border-linear-accent bg-linear-accent/10 text-linear-text"
                    : "border-linear-border bg-linear-bg text-linear-text-secondary hover:text-linear-text hover:border-linear-border"
                }`}
              >
                <option.icon className="w-5 h-5" />
                <span className="text-sm font-medium">{option.label}</span>
                {option.disabled && (
                  <span className="text-[10px] text-linear-text-tertiary">Coming soon</span>
                )}
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
                onClick={() => applyAccentColor(preset.accent, preset.solid)}
                className={`flex flex-col items-center gap-2 p-3 rounded-sm border transition-colors ${
                  accentColor === preset.accent
                    ? "border-linear-accent bg-linear-accent/10"
                    : "border-linear-border hover:border-linear-border-hover"
                }`}
              >
                <div className="relative">
                  <div className="w-8 h-8 rounded-full" style={{ backgroundColor: preset.accent }} />
                  {accentColor === preset.accent && (
                    <Check className="absolute inset-0 m-auto w-4 h-4 text-background" />
                  )}
                </div>
                <span className="text-xs text-linear-text-secondary">{preset.name}</span>
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
              <p className="text-xs text-linear-text-tertiary">Reduce spacing and padding throughout the interface</p>
            </div>
            <Switch checked={compactMode} onCheckedChange={setCompactMode} />
          </div>
          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Animations</p>
              <p className="text-xs text-linear-text-tertiary">Enable smooth transitions and motion effects</p>
            </div>
            <Switch checked={animations} onCheckedChange={setAnimations} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
