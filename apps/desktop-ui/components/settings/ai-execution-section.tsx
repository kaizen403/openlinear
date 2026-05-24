"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "sonner"
import { setActiveRepositoryBaseBranch } from "@/lib/api"
import { apiFetch } from "@/lib/api/fetch"

interface AIExecutionSectionProps {
  loading: boolean
  parallelLimit: number
  setParallelLimit: (v: number) => void
  maxBatchSize: number
  setMaxBatchSize: (v: number) => void
  queueAutoApprove: boolean
  setQueueAutoApprove: (v: boolean) => void
  stopOnFailure: boolean
  setStopOnFailure: (v: boolean) => void
  conflictBehavior: string
  setConflictBehavior: (v: string) => void
  autoRetry: boolean
  setAutoRetry: (v: boolean) => void
  taskDeletionMode: "archive" | "delete"
  activeRepositoryId: string | null
  activeRepositoryName: string | null
  setActiveRepositoryName: (v: string | null) => void
  prBaseBranch: string
  setPrBaseBranch: (v: string) => void
  savedPrBaseBranch: string
  setSavedPrBaseBranch: (v: string) => void
}

export function AIExecutionSection({
  loading,
  parallelLimit, setParallelLimit,
  maxBatchSize, setMaxBatchSize,
  queueAutoApprove, setQueueAutoApprove,
  stopOnFailure, setStopOnFailure,
  conflictBehavior, setConflictBehavior,
  autoRetry, setAutoRetry,
  taskDeletionMode,
  activeRepositoryId, activeRepositoryName, setActiveRepositoryName,
  prBaseBranch, setPrBaseBranch,
  savedPrBaseBranch, setSavedPrBaseBranch,
}: AIExecutionSectionProps) {
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    const normalizedBaseBranch = prBaseBranch.trim()
    if (activeRepositoryId && !normalizedBaseBranch) {
      toast.error("PR base branch cannot be empty")
      return
    }

    setSaving(true)
    try {
      await apiFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          parallelLimit,
          maxBatchSize,
          queueAutoApprove,
          stopOnFailure,
          conflictBehavior,
          taskDeletionMode,
        }),
      })

      if (activeRepositoryId && normalizedBaseBranch !== savedPrBaseBranch) {
        const repository = await setActiveRepositoryBaseBranch(normalizedBaseBranch)
        const savedBranch = repository.defaultBranch || normalizedBaseBranch
        setPrBaseBranch(savedBranch)
        setSavedPrBaseBranch(savedBranch)
        setActiveRepositoryName(repository.fullName)
      }

      toast.success("Settings saved")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to save settings"
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">AI Execution</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Configure parallel execution and batch processing for AI agents.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Parallel Execution</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Configure how many AI agents can run simultaneously when processing tasks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-linear-text-secondary">Parallel Limit</span>
                <span className="text-lg font-semibold text-linear-accent">{parallelLimit}</span>
              </div>
              <Slider value={[parallelLimit]} onValueChange={(value) => setParallelLimit(value[0])} min={1} max={5} step={1} className="w-full" />
              <div className="flex justify-between text-xs text-linear-text-tertiary">
                <span>1 (Sequential)</span>
                <span>5 (Maximum)</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Batch Execution</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Configure batch execution behavior for running multiple tasks together.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-linear-text-secondary">Max Batch Size</span>
                <span className="text-lg font-semibold text-linear-accent">{maxBatchSize}</span>
              </div>
              <Slider value={[maxBatchSize]} onValueChange={(value) => setMaxBatchSize(value[0])} min={1} max={10} step={1} className="w-full" />
              <div className="flex justify-between text-xs text-linear-text-tertiary">
                <span>1</span>
                <span>10</span>
              </div>

              <div className="flex items-center justify-between py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">Auto-Approve Queue</p>
                  <p className="text-xs text-linear-text-tertiary">Automatically start the next task in queue mode</p>
                </div>
                <Switch checked={queueAutoApprove} onCheckedChange={setQueueAutoApprove} />
              </div>

              <div className="flex items-center justify-between py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">Stop on Failure</p>
                  <p className="text-xs text-linear-text-tertiary">Cancel remaining tasks if one fails</p>
                </div>
                <Switch checked={stopOnFailure} onCheckedChange={setStopOnFailure} />
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">Merge Conflict Behavior</p>
                  <p className="text-xs text-linear-text-tertiary">What to do when task branches conflict</p>
                </div>
                <Select value={conflictBehavior} onValueChange={setConflictBehavior}>
                  <SelectTrigger className="w-full sm:w-32 bg-linear-bg border-linear-border text-linear-text">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-linear-bg-secondary border-linear-border">
                    <SelectItem value="skip">Skip</SelectItem>
                    <SelectItem value="fail">Fail</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between py-3 border-t border-linear-border">
                <div>
                  <p className="text-sm text-linear-text">Auto-Retry</p>
                  <p className="text-xs text-linear-text-tertiary">Automatically retry failed executions once</p>
                </div>
                <Switch checked={autoRetry} onCheckedChange={setAutoRetry} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Pull Request Target</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Choose the base branch OpenLinear uses for new pull requests.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-linear-text-tertiary">
            {activeRepositoryName ? `Active repository: ${activeRepositoryName}` : "No active repository selected"}
          </p>
          <div className="space-y-2">
            <Label htmlFor="pr-base-branch" className="text-sm text-linear-text block">Base branch</Label>
            <Input
              id="pr-base-branch"
              type="text"
              value={prBaseBranch}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPrBaseBranch(e.target.value)}
              placeholder={activeRepositoryId ? "main" : "Select a repository first"}
              disabled={!activeRepositoryId || loading}
              className="bg-linear-bg border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
            />
            <p className="text-xs text-linear-text-tertiary">This branch is used for clone base and PR target.</p>
          </div>
        </CardContent>
      </Card>

      {!loading && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving} className="bg-linear-accent hover:bg-linear-accent-hover text-white">
            {saving ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</>) : "Save Changes"}
          </Button>
        </div>
      )}
    </div>
  )
}
