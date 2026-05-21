"use client"

import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, Check, Clipboard, Key, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  createPersonalAccessToken,
  fetchPersonalAccessTokens,
  revokePersonalAccessToken,
  type CreatedPersonalAccessToken,
  type PersonalAccessToken,
} from "@/lib/api"

function formatDate(value: string | null) {
  if (!value) return "Never"
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))
}

function formatRelative(value: string | null) {
  if (!value) return "Never"

  const diffMs = Date.now() - new Date(value).getTime()
  const minutes = Math.round(diffMs / 60_000)
  if (minutes < 1) return "Just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(value)
}

function toIsoDatetimeLocal(value: string) {
  if (!value) return undefined
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString()
}

export function PersonalAccessTokensSection() {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [revokingId, setRevokingId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [expiresAt, setExpiresAt] = useState("")
  const [createdToken, setCreatedToken] = useState<CreatedPersonalAccessToken | null>(null)
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle")
  const [tokenToRevoke, setTokenToRevoke] = useState<PersonalAccessToken | null>(null)

  const activeTokens = useMemo(
    () => tokens.filter((token) => !token.revokedAt),
    [tokens],
  )

  async function loadTokens() {
    try {
      const data = await fetchPersonalAccessTokens()
      setTokens(data)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load tokens"
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadTokens()
  }, [])

  async function handleCreate() {
    const trimmedName = name.trim()
    if (!trimmedName) {
      toast.error("Token name is required")
      return
    }

    setCreating(true)
    try {
      const token = await createPersonalAccessToken({
        name: trimmedName,
        expiresAt: toIsoDatetimeLocal(expiresAt),
      })
      setCreatedToken(token)
      setTokens((current) => [
        {
          id: token.id,
          name: token.name,
          prefix: token.prefix,
          scopes: token.scopes,
          lastUsedAt: null,
          expiresAt: token.expiresAt,
          createdAt: token.createdAt,
          revokedAt: null,
        },
        ...current,
      ])
      setName("")
      setExpiresAt("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create token"
      toast.error(message)
    } finally {
      setCreating(false)
    }
  }

  async function handleCopyToken() {
    if (!createdToken) return
    try {
      await navigator.clipboard.writeText(createdToken.token)
      setCopyState("copied")
      window.setTimeout(() => {
        setCreatedToken(null)
        setCopyState("idle")
      }, 1200)
    } catch {
      toast.error("Could not copy token")
    }
  }

  async function handleRevoke() {
    if (!tokenToRevoke) return

    setRevokingId(tokenToRevoke.id)
    try {
      await revokePersonalAccessToken(tokenToRevoke.id)
      setTokens((current) =>
        current.map((token) =>
          token.id === tokenToRevoke.id
            ? { ...token, revokedAt: new Date().toISOString() }
            : token,
        ),
      )
      setTokenToRevoke(null)
      toast.success("Token revoked")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to revoke token"
      toast.error(message)
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-linear-text">API Keys</h2>
        <p className="text-sm text-linear-text-tertiary mt-1">
          Create personal access tokens for MCP clients and API integrations.
        </p>
      </div>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Create Token</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            Tokens are shown once and then stored as hashes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pat-name" className="text-sm text-linear-text">
              Name
            </Label>
            <Input
              id="pat-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="OpenCode MCP"
              className="bg-linear-bg border-linear-border text-linear-text"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="pat-expiry" className="text-sm text-linear-text">
              Expiration
            </Label>
            <Input
              id="pat-expiry"
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              className="bg-linear-bg border-linear-border text-linear-text"
            />
          </div>
          <Button
            onClick={() => void handleCreate()}
            disabled={creating}
            className="bg-linear-accent hover:bg-linear-accent-hover text-white gap-2"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create token
          </Button>
        </CardContent>
      </Card>

      <Card className="bg-linear-bg-secondary border-linear-border">
        <CardHeader>
          <CardTitle className="text-linear-text">Personal Access Tokens</CardTitle>
          <CardDescription className="text-linear-text-secondary">
            {activeTokens.length} active token{activeTokens.length === 1 ? "" : "s"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" />
            </div>
          ) : tokens.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
              <Key className="w-6 h-6 text-linear-text-tertiary" />
              <p className="text-sm text-linear-text-secondary">No tokens created yet</p>
            </div>
          ) : (
            <div className="divide-y divide-linear-border overflow-hidden rounded-sm border border-linear-border">
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                >
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-linear-text">{token.name}</p>
                      {token.revokedAt ? (
                        <Badge variant="outline" className="border-red-500/30 text-red-400">
                          Revoked
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="border-emerald-500/30 text-emerald-400">
                          Active
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-linear-text-tertiary">
                      <span className="font-mono">{token.prefix}...</span>
                      <span>Last used {formatRelative(token.lastUsedAt)}</span>
                      <span>Created {formatDate(token.createdAt)}</span>
                      <span>Expires {formatDate(token.expiresAt)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {token.scopes.map((scope) => (
                        <Badge
                          key={scope}
                          variant="secondary"
                          className="bg-linear-bg-tertiary text-linear-text-secondary"
                        >
                          {scope}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={Boolean(token.revokedAt) || revokingId === token.id}
                    onClick={() => setTokenToRevoke(token)}
                    className="justify-self-start border-linear-border text-linear-text hover:bg-linear-bg-tertiary sm:justify-self-end gap-2"
                  >
                    {revokingId === token.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(createdToken)} onOpenChange={(open) => {
        if (!open) {
          setCreatedToken(null)
          setCopyState("idle")
        }
      }}>
        <DialogContent className="bg-linear-bg-secondary border-linear-border text-linear-text">
          <DialogHeader>
            <DialogTitle>Token created</DialogTitle>
            <DialogDescription className="text-linear-text-secondary">
              You will not see this token again.
            </DialogDescription>
          </DialogHeader>
          {createdToken && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-sm border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <p>Store it in your MCP client now. OpenLinear only keeps the hash.</p>
              </div>
              <Input
                readOnly
                value={createdToken.token}
                onClick={(event) => event.currentTarget.select()}
                className="font-mono bg-linear-bg border-linear-border text-linear-text"
              />
            </div>
          )}
          <DialogFooter>
            <Button
              onClick={() => void handleCopyToken()}
              className="bg-linear-accent hover:bg-linear-accent-hover text-white gap-2"
            >
              {copyState === "copied" ? <Check className="w-4 h-4" /> : <Clipboard className="w-4 h-4" />}
              {copyState === "copied" ? "Copied" : "Copy token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(tokenToRevoke)} onOpenChange={(open) => !open && setTokenToRevoke(null)}>
        <AlertDialogContent className="bg-linear-bg-secondary border-linear-border text-linear-text">
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke token?</AlertDialogTitle>
            <AlertDialogDescription className="text-linear-text-secondary">
              Any client using this token will lose access immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleRevoke()}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
