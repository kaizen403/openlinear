"use client"

import { useState, useEffect } from "react"
import { Loader2, Rocket, Users2 } from "lucide-react"
import { Input } from "@/components/ui/input"
import { deriveTeamKey } from "./onboarding-utils"

export function TeamStep({
  projectName,
  teamName,
  isCreating,
  onNameChange,
  onBack,
  onCreate,
}: {
  projectName?: string
  teamName: string
  isCreating: boolean
  onNameChange: (name: string) => void
  onBack?: () => void
  onCreate: () => void
}) {
  const [key, setKey] = useState(() => deriveTeamKey(teamName || "Team"))
  const [keyDirty, setKeyDirty] = useState(false)

  useEffect(() => {
    if (keyDirty) return
    if (teamName.trim()) {
      setKey(deriveTeamKey(teamName))
    }
  }, [teamName, keyDirty])

  const canCreate = teamName.trim().length > 0 && /^[A-Z][A-Z0-9]*$/.test(key.trim())

  return (
    <div className="space-y-4">
      <div className="text-center space-y-1.5">
        <div className="w-10 h-10 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-2">
          <Users2 className="w-5 h-5 text-linear-accent" />
        </div>
        <h2 className="text-lg font-semibold text-linear-text">Set up a team</h2>
        <p className="text-xs text-linear-text-secondary">
          {projectName
            ? `Issues in ${projectName} need a team and key.`
            : "Issues need a team and key before you can create them."}
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="onboarding-team-name" className="text-xs font-medium text-linear-text-secondary">
            Team name
          </label>
          <Input
            id="onboarding-team-name"
            value={teamName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g., Frontend"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="onboarding-team-key" className="text-xs font-medium text-linear-text-secondary">
            Team key
          </label>
          <Input
            id="onboarding-team-key"
            value={key}
            onChange={(e) => {
              setKeyDirty(true)
              setKey(e.target.value.toUpperCase())
            }}
            placeholder="e.g., FE"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9"
          />
          <p className="text-xs text-linear-text-tertiary">
            This becomes the issue prefix, for example {key.trim() || "TEAM"}-1.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-9 px-4 text-sm font-medium transition-colors"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={onCreate}
          disabled={isCreating || !canCreate}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-9 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Finishing setup...
            </>
          ) : (
            <>
              <Rocket className="w-4 h-4" />
              Finish setup
            </>
          )}
        </button>
      </div>
    </div>
  )
}
