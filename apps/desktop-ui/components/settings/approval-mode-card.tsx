"use client"

import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { apiFetch } from "@/lib/api/fetch"
import { toastApiError } from "@/lib/api/errors"
import { queryKeys } from "@/lib/query/keys"
import { settingsQuery, type UserSettings } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

/**
 * FE-04: whether agent permission requests (a shell command, an edit the
 * runner asks about) are answered by policy or wait for you. Applies to runs
 * started after saving (each run seals it at start); runners that only
 * support policy decisions (Codex) keep deciding by policy.
 */

export function approvalModeOf(settings: UserSettings | undefined): "auto" | "ask" {
  return settings?.approvalMode === "ask" ? "ask" : "auto"
}

export function ApprovalModeCard() {
  const client = useAppQueryClient()
  const settings = useQuery(settingsQuery(), client)
  const mode = approvalModeOf(settings.data)
  const save = useMutation({
    mutationFn: (next: "auto" | "ask") => apiFetch<UserSettings>("/api/settings", { method: "PATCH", body: JSON.stringify({ approvalMode: next }) }),
    onSuccess: (row) => {
      client.setQueryData(queryKeys.settings(), row)
      toast.success(approvalModeOf(row) === "ask" ? "Agents will ask before acting" : "Agents act by policy")
    },
    onError: (error) => { toastApiError(error, { fallbackMessage: "Couldn't save the approval setting" }) },
  }, client)

  return (
    <Card className="bg-linear-bg-secondary border-linear-border">
      <CardHeader>
        <CardTitle className="text-base text-linear-text">Approvals</CardTitle>
        <CardDescription className="text-linear-text-secondary">
          When a runner asks before using a tool (a shell command, an edit), the run waits for your answer instead of deciding by policy. Unanswered requests are denied after 15 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <label htmlFor="approval-mode" className="text-sm text-linear-text">Ask me before the agent acts</label>
        <Switch
          id="approval-mode"
          checked={mode === "ask"}
          disabled={settings.isLoading || save.isPending}
          onCheckedChange={(checked) => save.mutate(checked ? "ask" : "auto")}
        />
      </CardContent>
    </Card>
  )
}
