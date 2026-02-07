"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { ArrowLeft, Settings, Loader2 } from "lucide-react"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast, Toaster } from "sonner"
import { DatabaseSettings } from "@/components/desktop/database-settings"

export default function SettingsPage() {
  const [parallelLimit, setParallelLimit] = useState(3)
  const [maxBatchSize, setMaxBatchSize] = useState(3)
  const [queueAutoApprove, setQueueAutoApprove] = useState(false)
  const [stopOnFailure, setStopOnFailure] = useState(false)
  const [conflictBehavior, setConflictBehavior] = useState("skip")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const response = await fetch("http://localhost:3001/api/settings")
        if (response.ok) {
          const data = await response.json()
          setParallelLimit(data.parallelLimit)
          setMaxBatchSize(data.maxBatchSize ?? 3)
          setQueueAutoApprove(data.queueAutoApprove ?? false)
          setStopOnFailure(data.stopOnFailure ?? false)
          setConflictBehavior(data.conflictBehavior ?? "skip")
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

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await fetch("http://localhost:3001/api/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ 
        parallelLimit,
        maxBatchSize,
        queueAutoApprove,
        stopOnFailure,
        conflictBehavior,
      }),
      })

      if (response.ok) {
        toast.success("Settings saved successfully")
      } else {
        toast.error("Failed to save settings")
      }
    } catch (error) {
      console.error("Failed to save settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-linear-bg text-linear-text">
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "hsl(var(--linear-bg-secondary))",
            border: "1px solid hsl(var(--linear-border))",
            color: "hsl(var(--linear-text))",
          },
        }}
      />
      
      <header className="h-14 border-b border-linear-border flex items-center px-6 bg-linear-bg">
        <Link
          href="/"
          className="flex items-center gap-2 text-linear-text-secondary hover:text-linear-text transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Board
        </Link>
      </header>

      <main className="max-w-2xl mx-auto p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-lg bg-linear-accent flex items-center justify-center">
            <Settings className="w-5 h-5 text-white" />
          </div>
          <h1 className="text-2xl font-semibold">Settings</h1>
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
              <>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-linear-text-secondary">Parallel Limit</span>
                    <span className="text-lg font-semibold text-linear-accent">{parallelLimit}</span>
                  </div>
                  <Slider
                    value={[parallelLimit]}
                    onValueChange={(value) => setParallelLimit(value[0])}
                    min={1}
                    max={5}
                    step={1}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-linear-text-tertiary">
                    <span>1 (Sequential)</span>
                    <span>5 (Maximum)</span>
                  </div>
                </div>

                <div className="pt-4 border-t border-linear-border">
                  <Button
                    onClick={handleSave}
                    disabled={saving}
                    className="bg-linear-accent hover:bg-linear-accent-hover text-white"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      "Save Changes"
                    )}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="bg-linear-bg-secondary border-linear-border mt-4">
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
              <>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-linear-text-secondary">Max Batch Size</span>
                    <span className="text-lg font-semibold text-linear-accent">{maxBatchSize}</span>
                  </div>
                  <Slider
                    value={[maxBatchSize]}
                    onValueChange={(value) => setMaxBatchSize(value[0])}
                    min={1}
                    max={10}
                    step={1}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-linear-text-tertiary">
                    <span>1</span>
                    <span>10</span>
                  </div>
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm text-linear-text">Auto-Approve Queue</p>
                    <p className="text-xs text-linear-text-tertiary">Automatically start the next task in queue mode</p>
                  </div>
                  <Switch checked={queueAutoApprove} onCheckedChange={setQueueAutoApprove} />
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm text-linear-text">Stop on Failure</p>
                    <p className="text-xs text-linear-text-tertiary">Cancel remaining tasks if one fails</p>
                  </div>
                  <Switch checked={stopOnFailure} onCheckedChange={setStopOnFailure} />
                </div>

                <div className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm text-linear-text">Merge Conflict Behavior</p>
                    <p className="text-xs text-linear-text-tertiary">What to do when task branches conflict</p>
                  </div>
                  <Select value={conflictBehavior} onValueChange={setConflictBehavior}>
                    <SelectTrigger className="w-32 bg-linear-bg border-linear-border text-linear-text">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-linear-bg-secondary border-linear-border">
                      <SelectItem value="skip">Skip</SelectItem>
                      <SelectItem value="fail">Fail</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="pt-4 border-t border-linear-border">
                  <Button onClick={handleSave} disabled={saving} className="bg-linear-accent hover:bg-linear-accent-hover text-white">
                    {saving ? (<><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</>) : "Save Changes"}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <DatabaseSettings />
      </main>
    </div>
  )
}
