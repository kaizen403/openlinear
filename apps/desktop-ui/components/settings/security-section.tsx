"use client"

import { useState } from "react"
import { Shield } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EmptyState } from "@/components/empty-state"

export function SecuritySection() {
  const [twoFactor] = useState(false)
  const [sessionTimeout, setSessionTimeout] = useState("4h")

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">Security & Privacy</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Manage authentication and session security.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Authentication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-3">
            <div>
              <p className="text-sm text-linear-text">Two-factor authentication</p>
              <p className="text-xs text-linear-text-tertiary">
                Add an extra layer of security to your account.{" "}
                <span className="text-linear-text-tertiary">Coming soon.</span>
              </p>
            </div>
            <Switch checked={twoFactor} disabled aria-label="Two-factor authentication (coming soon)" />
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 py-3 border-t border-linear-border">
            <div>
              <p className="text-sm text-linear-text">Session timeout</p>
              <p className="text-xs text-linear-text-tertiary">Automatically log out after a period of inactivity</p>
            </div>
            <Select value={sessionTimeout} onValueChange={setSessionTimeout}>
              <SelectTrigger className="w-full sm:w-36 bg-linear-bg border-linear-border text-linear-text">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-linear-bg-secondary border-linear-border">
                <SelectItem value="30m">30 minutes</SelectItem>
                <SelectItem value="1h">1 hour</SelectItem>
                <SelectItem value="4h">4 hours</SelectItem>
                <SelectItem value="8h">8 hours</SelectItem>
                <SelectItem value="never">Never</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Active Sessions</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Devices currently signed into your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Shield}
            size="compact"
            title="No active session data yet"
            description="Per-device session tracking will appear here once it ships."
          />
        </CardContent>
      </Card>
    </div>
  )
}
