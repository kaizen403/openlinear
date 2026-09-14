"use client"

import { useState } from "react"
import { Bell } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"

export function NotificationsSection() {
  const [emailNotifications] = useState(true)
  const [pushNotifications] = useState(true)
  const [soundEnabled] = useState(true)
  const [mentionNotifs] = useState(true)
  const [assignmentNotifs] = useState(true)
  const [statusChangeNotifs] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">Notifications</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Configure how and when you receive notifications.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardContent className="py-4">
          <div className="flex items-start gap-3">
            <Bell className="w-4 h-4 text-linear-text-tertiary flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm text-linear-text">
                Per-user notification preferences are coming soon
              </p>
              <p className="text-xs text-linear-text-tertiary">
                The controls below are previews and don&apos;t persist yet.
                You&apos;ll still receive in-app notifications for mentions,
                assignments, and PR updates from the inbox.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border opacity-60">
        <CardHeader>
          <CardTitle className="text-linear-text">Channels</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Choose how you want to be notified.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Email notifications</p>
              <p className="text-xs text-linear-text-tertiary">Receive updates via email</p>
            </div>
            <Switch checked={emailNotifications} disabled />
          </div>
          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Push notifications</p>
              <p className="text-xs text-linear-text-tertiary">Browser and desktop push alerts</p>
            </div>
            <Switch checked={pushNotifications} disabled />
          </div>
          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Sound</p>
              <p className="text-xs text-linear-text-tertiary">Play a sound for incoming notifications</p>
            </div>
            <Switch checked={soundEnabled} disabled />
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border opacity-60">
        <CardHeader>
          <CardTitle className="text-linear-text">Event Types</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Fine-tune which events trigger notifications.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Mentions</p>
              <p className="text-xs text-linear-text-tertiary">When someone mentions you in a comment</p>
            </div>
            <Switch checked={mentionNotifs} disabled />
          </div>
          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Assignments</p>
              <p className="text-xs text-linear-text-tertiary">When a task is assigned to you</p>
            </div>
            <Switch checked={assignmentNotifs} disabled />
          </div>
          <div className="flex items-center justify-between py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Status changes</p>
              <p className="text-xs text-linear-text-tertiary">When a task you are watching changes status</p>
            </div>
            <Switch checked={statusChangeNotifs} disabled />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
