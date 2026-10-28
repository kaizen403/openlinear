"use client"

import { useId, useState } from "react"
import { Loader2 } from "lucide-react"
import { focusRing } from "@/components/ui/focus-ring"
import { useWorkspace } from "@/hooks/use-workspace"
import { cn } from "@/lib/utils"
import { WorkspaceWebhooksSection } from "./webhooks-section"

/**
 * FE-14: Settings → Webhooks — the webhooks of a workspace (events of every
 * project in it, or one daily digest for all of them). Starts on the active
 * workspace; a picker switches when you belong to several. Project webhooks
 * stay in each project's settings.
 */
export function WorkspaceWebhooksSettings() {
  const { activeWorkspace, workspaces, isLoading } = useWorkspace()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const pickerId = useId()
  const workspaceId = (selectedId && workspaces.some((workspace) => workspace.id === selectedId) ? selectedId : null)
    ?? activeWorkspace?.id
    ?? workspaces[0]?.id
    ?? null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-linear-text">Webhooks</h2>
          <p className="mt-1 text-sm text-linear-text-tertiary">
            Send events from every project of a workspace to your own service, or post them to Slack or Discord. Webhooks for a single project are in that project&apos;s settings.
          </p>
        </div>
        {workspaces.length > 1 && workspaceId && (
          <div className="flex items-center gap-2">
            <label htmlFor={pickerId} className="text-xs text-linear-text-secondary">Workspace</label>
            <select
              id={pickerId}
              value={workspaceId}
              onChange={(event) => setSelectedId(event.target.value)}
              className={cn("h-8 rounded-sm border border-linear-border bg-linear-bg px-2 text-sm text-linear-text", focusRing)}
            >
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
          </div>
        )}
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-linear-text-tertiary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          Loading workspaces…
        </div>
      ) : workspaceId ? (
        <WorkspaceWebhooksSection key={workspaceId} workspaceId={workspaceId} />
      ) : (
        <p className="text-xs text-linear-text-tertiary">You are not in a workspace yet.</p>
      )}
    </div>
  )
}
