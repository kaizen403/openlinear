"use client"

import { useState, useEffect, useCallback, Suspense } from "react"
import { Settings, Loader2, Globe, Palette, Bell, Cpu, Shield, Key, Database, Brain, User as UserIcon, Building2 } from "lucide-react"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { getActiveRepository } from "@/lib/api"
import { apiFetch } from "@/lib/api/fetch"
import { DatabaseSettings } from "@/components/desktop/database-settings"
import { AIProvidersSection } from "@/components/settings/ai-providers-section"
import { PersonalAccessTokensSection } from "@/components/settings/personal-access-tokens-section"
import { WorkspacesSection } from "@/components/settings/workspaces-section"
import { ProfileSection } from "@/components/settings/profile-section"
import { GeneralSection } from "@/components/settings/general-section"
import { AppearanceSection } from "@/components/settings/appearance-section"
import { NotificationsSection } from "@/components/settings/notifications-section"
import { AIExecutionSection } from "@/components/settings/ai-execution-section"
import { SecuritySection } from "@/components/settings/security-section"

type SettingsSection =
  | "profile" | "workspaces" | "general" | "appearance"
  | "notifications" | "ai-execution" | "ai-providers"
  | "security" | "api-keys" | "database"

const NAV_ITEMS: { id: SettingsSection; label: string; icon: React.ElementType }[] = [
  { id: "profile", label: "Profile", icon: UserIcon },
  { id: "workspaces", label: "Workspaces", icon: Building2 },
  { id: "general", label: "General", icon: Globe },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "ai-execution", label: "AI Execution", icon: Cpu },
  { id: "ai-providers", label: "AI Providers", icon: Brain },
  { id: "security", label: "Security & Privacy", icon: Shield },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "database", label: "Database", icon: Database },
]

function SettingsContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const requestedSection = searchParams.get("section")
  const initialSection = NAV_ITEMS.some((item) => item.id === requestedSection)
    ? (requestedSection as SettingsSection)
    : "profile"
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection)

  // Shared AI execution state (loaded once, passed to section)
  const [parallelLimit, setParallelLimit] = useState(3)
  const [maxBatchSize, setMaxBatchSize] = useState(3)
  const [queueAutoApprove, setQueueAutoApprove] = useState(false)
  const [stopOnFailure, setStopOnFailure] = useState(false)
  const [conflictBehavior, setConflictBehavior] = useState("skip")
  const [autoRetry, setAutoRetry] = useState(false)
  const [taskDeletionMode, setTaskDeletionMode] = useState<"archive" | "delete">("archive")
  const [loading, setLoading] = useState(true)
  const [activeRepositoryId, setActiveRepositoryId] = useState<string | null>(null)
  const [activeRepositoryName, setActiveRepositoryName] = useState<string | null>(null)
  const [prBaseBranch, setPrBaseBranch] = useState("")
  const [savedPrBaseBranch, setSavedPrBaseBranch] = useState("")

  useEffect(() => {
    const section = searchParams.get("section")
    if (!section) {
      setActiveSection("profile")
    } else if (NAV_ITEMS.some((item) => item.id === section)) {
      setActiveSection(section as SettingsSection)
    }
  }, [searchParams])

  const selectSection = useCallback((section: SettingsSection) => {
    setActiveSection(section)
    router.replace(section === "profile" ? "/settings" : `/settings?section=${section}`, { scroll: false })
  }, [router])

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const [settingsData, activeRepository] = await Promise.all([
          apiFetch<{
            parallelLimit: number
            maxBatchSize?: number
            queueAutoApprove?: boolean
            stopOnFailure?: boolean
            conflictBehavior?: string
            taskDeletionMode?: "archive" | "delete"
          }>('/api/settings').catch(() => null),
          getActiveRepository().catch(() => null),
        ])

        if (settingsData) {
          setParallelLimit(settingsData.parallelLimit)
          setMaxBatchSize(settingsData.maxBatchSize ?? 3)
          setQueueAutoApprove(settingsData.queueAutoApprove ?? false)
          setStopOnFailure(settingsData.stopOnFailure ?? false)
          setConflictBehavior(settingsData.conflictBehavior ?? "skip")
          setTaskDeletionMode(settingsData.taskDeletionMode ?? "archive")
        }

        if (activeRepository) {
          const baseBranch = activeRepository.defaultBranch || "main"
          setActiveRepositoryId(activeRepository.id)
          setActiveRepositoryName(activeRepository.fullName)
          setPrBaseBranch(baseBranch)
          setSavedPrBaseBranch(baseBranch)
        } else {
          setActiveRepositoryId(null)
          setActiveRepositoryName(null)
          setPrBaseBranch("")
          setSavedPrBaseBranch("")
        }
      } catch (error) {
        console.error("Failed to fetch settings:", error)
        toast.error("Failed to load settings")
      } finally {
        setLoading(false)
      }
    }
    fetchSettings()
  }, [])

  const renderContent = () => {
    switch (activeSection) {
      case "profile": return <ProfileSection />
      case "workspaces": return <WorkspacesSection />
      case "general": return <GeneralSection taskDeletionMode={taskDeletionMode} setTaskDeletionMode={setTaskDeletionMode} />
      case "appearance": return <AppearanceSection />
      case "notifications": return <NotificationsSection />
      case "ai-execution": return (
        <AIExecutionSection
          loading={loading}
          parallelLimit={parallelLimit} setParallelLimit={setParallelLimit}
          maxBatchSize={maxBatchSize} setMaxBatchSize={setMaxBatchSize}
          queueAutoApprove={queueAutoApprove} setQueueAutoApprove={setQueueAutoApprove}
          stopOnFailure={stopOnFailure} setStopOnFailure={setStopOnFailure}
          conflictBehavior={conflictBehavior} setConflictBehavior={setConflictBehavior}
          autoRetry={autoRetry} setAutoRetry={setAutoRetry}
          taskDeletionMode={taskDeletionMode}
          activeRepositoryId={activeRepositoryId}
          activeRepositoryName={activeRepositoryName} setActiveRepositoryName={setActiveRepositoryName}
          prBaseBranch={prBaseBranch} setPrBaseBranch={setPrBaseBranch}
          savedPrBaseBranch={savedPrBaseBranch} setSavedPrBaseBranch={setSavedPrBaseBranch}
        />
      )
      case "ai-providers": return <AIProvidersSection />
      case "security": return <SecuritySection />
      case "api-keys": return <PersonalAccessTokensSection />
      case "database": return (
        <div className="space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-linear-text">Database</h2>
            <p className="text-sm text-linear-text-tertiary mt-1">Manage your database connection and configuration.</p>
          </div>
          <DatabaseSettings />
        </div>
      )
    }
  }

  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-2 sm:gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Settings className="w-4 h-4 text-linear-text-secondary flex-shrink-0" />
          <h1 className="text-lg font-semibold truncate">Settings</h1>
        </div>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>

      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-hidden">
        <nav className="flex-shrink-0 border-b md:border-b-0 md:border-r border-linear-border bg-linear-bg overflow-x-auto md:overflow-y-auto md:w-52 py-2 md:py-3 px-2 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
          <div className="flex md:flex-col gap-1 min-w-max md:min-w-0">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon
              const isActive = activeSection === item.id
              return (
                <button
                  key={item.id}
                  onClick={() => selectSection(item.id)}
                  className={`flex items-center gap-2.5 px-3 py-2 rounded-sm text-sm whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-linear-bg-tertiary text-linear-text"
                      : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
                  }`}
                >
                  <Icon className="w-4 h-4 flex-shrink-0" />
                  {item.label}
                </button>
              )
            })}
          </div>
        </nav>

        <main className="flex-1 min-h-0 overflow-y-auto p-6 sm:p-8">
          <div className="pb-8">{renderContent()}</div>
        </main>
      </div>
    </>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-screen bg-linear-bg"><Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" /></div>}>
      <SettingsContent />
    </Suspense>
  )
}
