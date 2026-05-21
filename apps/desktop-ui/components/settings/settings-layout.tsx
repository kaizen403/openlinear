"use client"

import type { ReactNode } from "react"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface SettingsPageShellProps {
  title: string
  subtitle?: string
  icon?: ReactNode
  backLabel: string
  onBack: () => void
  children: ReactNode
  actions?: ReactNode
}

export function SettingsPageShell({
  title,
  subtitle = "Settings",
  icon,
  backLabel,
  onBack,
  children,
  actions,
}: SettingsPageShellProps) {
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-linear-bg">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-linear-border px-4 sm:px-6">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-linear-text-tertiary hover:text-linear-text"
          onClick={onBack}
          aria-label={`Back to ${backLabel}`}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-linear-text">
          {icon && <div className="shrink-0 text-linear-text-tertiary">{icon}</div>}
          <span className="truncate">{title}</span>
          {subtitle && (
            <>
              <span className="shrink-0 text-linear-text-tertiary">/</span>
              <span className="shrink-0 text-linear-text-tertiary">{subtitle}</span>
            </>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl space-y-8 p-6 sm:p-8">
          {children}
        </div>
      </main>
    </div>
  )
}

interface SettingsSectionProps {
  title: string
  description?: string
  icon?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}

export function SettingsSection({
  title,
  description,
  icon,
  actions,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section className={cn("border-t border-linear-border pt-6 first:border-t-0 first:pt-0", className)}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-2">
          {icon && <div className="mt-0.5 shrink-0 text-linear-text-tertiary">{icon}</div>}
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-linear-text">{title}</h2>
            {description && (
              <p className="mt-1 max-w-2xl text-xs leading-5 text-linear-text-tertiary">
                {description}
              </p>
            )}
          </div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

interface SettingsPanelProps {
  children: ReactNode
  className?: string
}

export function SettingsPanel({ children, className }: SettingsPanelProps) {
  return (
    <div className={cn("rounded-sm border border-linear-border bg-linear-bg-secondary", className)}>
      {children}
    </div>
  )
}
