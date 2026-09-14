"use client"

import { useState, useEffect } from "react"
import { Moon, Sun, Laptop, Check } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useTheme } from "next-themes"

const DEFAULT_ACCENT = { accent: "#10b981", hover: "#059669" }
const LEGACY_ACCENTS = new Set(["#1d4ed8", "#1e40af", "#3b82f6", "#2563eb"])

const ACCENT_PRESETS = [
  { name: "Emerald", accent: DEFAULT_ACCENT.accent, hover: DEFAULT_ACCENT.hover },
  { name: "Purple", accent: "#8b5cf6", hover: "#7c3aed" },
  { name: "Green", accent: "#22c55e", hover: "#16a34a" },
  { name: "Orange", accent: "#f97316", hover: "#ea580c" },
  { name: "Pink", accent: "#ec4899", hover: "#db2777" },
  { name: "Red", accent: "#ef4444", hover: "#dc2626" },
  { name: "Teal", accent: "#14b8a6", hover: "#0d9488" },
  { name: "Yellow", accent: "#eab308", hover: "#ca8a04" },
] as const

function hexToRgbTriplet(hex: string, fallback: string) {
  let normalized = hex.replace("#", "").trim()
  if (normalized.length === 3) {
    normalized = normalized.split("").map((char) => char + char).join("")
  }
  const value = Number.parseInt(normalized, 16)
  if (!Number.isFinite(value) || normalized.length !== 6) return fallback
  return `${(value >> 16) & 255} ${(value >> 8) & 255} ${value & 255}`
}

function applyAccentVariables(accent: string, hover: string) {
  document.documentElement.style.setProperty("--linear-accent", accent)
  document.documentElement.style.setProperty("--linear-accent-hover", hover)
  document.documentElement.style.setProperty("--linear-accent-rgb", hexToRgbTriplet(accent, "16 185 129"))
  document.documentElement.style.setProperty("--linear-accent-hover-rgb", hexToRgbTriplet(hover, "5 150 105"))
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()
  const [compactMode, setCompactMode] = useState(false)
  const [animations, setAnimations] = useState(true)
  const [accentColor, setAccentColor] = useState(DEFAULT_ACCENT.accent)

  useEffect(() => {
    try {
      const stored = localStorage.getItem("openlinear-accent")
      if (stored) {
        let { accent, hover } = JSON.parse(stored)
        if (LEGACY_ACCENTS.has(String(accent).toLowerCase()) || LEGACY_ACCENTS.has(String(hover).toLowerCase())) {
          accent = DEFAULT_ACCENT.accent
          hover = DEFAULT_ACCENT.hover
          localStorage.setItem("openlinear-accent", JSON.stringify({ accent, hover }))
        }
        setAccentColor(accent)
        applyAccentVariables(accent, hover)
      }
    } catch {}
  }, [])

  const applyAccentColor = (accent: string, hover: string) => {
    setAccentColor(accent)
    applyAccentVariables(accent, hover)
    try {
      localStorage.setItem("openlinear-accent", JSON.stringify({ accent, hover }))
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
                onClick={() => applyAccentColor(preset.accent, preset.hover)}
                className={`flex flex-col items-center gap-2 p-3 rounded-sm border transition-colors ${
                  accentColor === preset.accent
                    ? "border-linear-accent bg-linear-accent/10"
                    : "border-linear-border hover:border-linear-border-hover"
                }`}
              >
                <div className="relative">
                  <div className="w-8 h-8 rounded-full" style={{ backgroundColor: preset.accent }} />
                  {accentColor === preset.accent && (
                    <Check className="absolute inset-0 m-auto w-4 h-4 text-white" />
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
