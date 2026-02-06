"use client"

import * as React from "react"
import { invoke } from "@tauri-apps/api/core"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Database, Loader2, CheckCircle, XCircle, Eye, EyeOff } from "lucide-react"

interface ConnectionStatus {
  connected: boolean
  error: string | null
}

export function DatabaseSettings() {
  const [databaseUrl, setDatabaseUrl] = React.useState("")
  const [showPassword, setShowPassword] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [connectionStatus, setConnectionStatus] = React.useState<ConnectionStatus | null>(null)
  const [isTauri, setIsTauri] = React.useState(false)

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        const { load } = await import("@tauri-apps/plugin-store")
        const store = await load("settings.json")
        const savedUrl = await store.get<string>("database_url")
        if (savedUrl) {
          setDatabaseUrl(savedUrl)
        }
        setIsTauri(true)
      } catch {
        setIsTauri(false)
      }
    }
    loadSettings()
  }, [])

  const handleSave = async () => {
    if (!isTauri) return
    setSaving(true)
    try {
      const { load } = await import("@tauri-apps/plugin-store")
      const store = await load("settings.json")
      await store.set("database_url", databaseUrl)
      await store.save()
      setConnectionStatus({ connected: true, error: null })
    } catch (error) {
      setConnectionStatus({ connected: false, error: String(error) })
    } finally {
      setSaving(false)
    }
  }

  const handleTestConnection = async () => {
    setTesting(true)
    setConnectionStatus(null)
    try {
      const result = await invoke<{ success: boolean; error?: string }>("test_database_connection", {
        databaseUrl,
      })
      setConnectionStatus({
        connected: result.success,
        error: result.error || null,
      })
    } catch (error) {
      setConnectionStatus({
        connected: false,
        error: "Failed to test connection. Ensure the API server is running.",
      })
    } finally {
      setTesting(false)
    }
  }

  if (!isTauri) {
    return null
  }

  return (
    <Card className="bg-linear-bg-secondary border-linear-border">
      <CardHeader>
        <CardTitle className="text-linear-text flex items-center gap-2">
          <Database className="w-5 h-5" />
          Database Connection
        </CardTitle>
        <CardDescription className="text-linear-text-secondary">
          Configure the PostgreSQL connection string for the API server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-linear-text">
            DATABASE_URL
          </label>
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              value={databaseUrl}
              onChange={(e) => setDatabaseUrl(e.target.value)}
              placeholder="postgresql://user:password@host:5432/database"
              className="pr-10 font-mono text-sm bg-linear-bg border-linear-border text-linear-text"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-linear-text-secondary hover:text-linear-text"
            >
              {showPassword ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </button>
          </div>
          <p className="text-xs text-linear-text-tertiary">
            This URL is stored securely and passed to the API server on startup.
          </p>
        </div>

        {connectionStatus && (
          <div
            className={`flex items-center gap-2 p-3 rounded-lg ${
              connectionStatus.connected
                ? "bg-green-500/10 text-green-400"
                : "bg-red-500/10 text-red-400"
            }`}
          >
            {connectionStatus.connected ? (
              <>
                <CheckCircle className="h-4 w-4" />
                <span className="text-sm">Connection successful</span>
              </>
            ) : (
              <>
                <XCircle className="h-4 w-4" />
                <span className="text-sm">{connectionStatus.error || "Connection failed"}</span>
              </>
            )}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !databaseUrl}
            className="border-linear-border"
          >
            {testing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Testing...
              </>
            ) : (
              "Test Connection"
            )}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !databaseUrl}
            className="bg-linear-accent hover:bg-linear-accent-hover text-white"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
