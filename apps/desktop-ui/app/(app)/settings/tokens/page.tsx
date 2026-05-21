"use client"

import { Key } from "lucide-react"
import { PersonalAccessTokensSection } from "@/components/settings/personal-access-tokens-section"

export default function SettingsTokensPage() {
  return (
    <>
      <header className="h-14 border-b border-linear-border flex items-center px-4 sm:px-6 bg-linear-bg gap-3">
        <Key className="w-4 h-4 text-linear-text-secondary flex-shrink-0" />
        <h1 className="text-lg font-semibold truncate">Personal Access Tokens</h1>
        <div className="flex-1 h-full" data-tauri-drag-region />
      </header>
      <main className="flex-1 overflow-y-auto p-6 sm:p-8">
        <div className="max-w-2xl pb-8">
          <PersonalAccessTokensSection />
        </div>
      </main>
    </>
  )
}
