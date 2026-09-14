"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

interface GeneralSectionProps {
  taskDeletionMode: "archive" | "delete"
  setTaskDeletionMode: (mode: "archive" | "delete") => void
}

export function GeneralSection({ taskDeletionMode, setTaskDeletionMode }: GeneralSectionProps) {
  const [language, setLanguage] = useState("en")
  const [timezone, setTimezone] = useState("UTC")
  const [autoSave, setAutoSave] = useState(true)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">General</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Manage your workspace preferences and regional settings.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Regional</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3">
            <div>
              <p className="text-sm text-linear-text">Language</p>
              <p className="text-xs text-linear-text-tertiary">Display language for the interface</p>
            </div>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger className="w-full sm:w-40 bg-linear-bg border-linear-border text-linear-text">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg-secondary border-linear-border">
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Spanish</SelectItem>
                <SelectItem value="fr">French</SelectItem>
                <SelectItem value="ja">Japanese</SelectItem>
                <SelectItem value="de">German</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Timezone</p>
              <p className="text-xs text-linear-text-tertiary">Used for timestamps and scheduling</p>
            </div>
            <Select value={timezone} onValueChange={setTimezone}>
              <SelectTrigger className="w-full sm:w-48 bg-linear-bg border-linear-border text-linear-text">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg-secondary border-linear-border">
                <SelectItem value="UTC">UTC</SelectItem>
                <SelectItem value="America/New_York">Eastern (ET)</SelectItem>
                <SelectItem value="America/Chicago">Central (CT)</SelectItem>
                <SelectItem value="America/Denver">Mountain (MT)</SelectItem>
                <SelectItem value="America/Los_Angeles">Pacific (PT)</SelectItem>
                <SelectItem value="Europe/London">London (GMT)</SelectItem>
                <SelectItem value="Europe/Berlin">Berlin (CET)</SelectItem>
                <SelectItem value="Asia/Tokyo">Tokyo (JST)</SelectItem>
                <SelectItem value="Asia/Kolkata">India (IST)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Behavior</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Auto-save</p>
              <p className="text-xs text-linear-text-tertiary">Automatically save changes as you work</p>
            </div>
            <Switch checked={autoSave} onCheckedChange={setAutoSave} />
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Task deletion mode</p>
              <p className="text-xs text-linear-text-tertiary">Choose what happens when you remove a task from the board</p>
            </div>
            <Select value={taskDeletionMode} onValueChange={(v: "archive" | "delete") => setTaskDeletionMode(v)}>
              <SelectTrigger className="w-full sm:w-40 bg-linear-bg border-linear-border text-linear-text">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg-secondary border-linear-border">
                <SelectItem value="archive">Archive</SelectItem>
                <SelectItem value="delete">Delete</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
