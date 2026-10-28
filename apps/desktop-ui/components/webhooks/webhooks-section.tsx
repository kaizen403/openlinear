"use client"

import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { History, KeyRound, Loader2, Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from "lucide-react"
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
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { SettingsPanel, SettingsSection } from "@/components/settings/settings-layout"
import { describeApiError, toastApiError } from "@/lib/api/errors"
import {
  WEBHOOK_FORMAT_LABELS,
  deleteWebhook,
  digestScheduleText,
  disabledReasonText,
  eventTypeLabel,
  fetchProjectWebhooks,
  fetchWorkspaceWebhooks,
  formatTime,
  pingWebhook,
  rotateWebhookSecret,
  updateWebhook,
  webhookFormatOf,
  webhookKeys,
  type Webhook,
  type WebhookFormat,
  type WebhookScope,
} from "@/lib/api/webhooks"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"
import { WebhookDeliveries } from "./webhook-deliveries"
import { WebhookForm } from "./webhook-form"
import { WebhookSecretNotice } from "./webhook-secret"

/**
 * FE-14: outbound webhooks of a project (project settings) or of a
 * workspace (Settings → Webhooks). Workspace owners/admins (with full
 * project access, for a project) add, edit, turn off/on, ping, rotate and
 * delete; everyone who sees the project — or every workspace member — reads
 * the list (URL reduced to its origin) and the delivery history.
 */

const actionClass = cn("inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text disabled:opacity-50", focusRing)

type Confirm = { kind: "delete" | "rotate"; webhook: Webhook } | null

function eventSummary(types: string[]): string {
  const labels = types.map(eventTypeLabel)
  return labels.length <= 3 ? labels.join(", ") : `${labels.slice(0, 3).join(", ")} +${labels.length - 3}`
}

function WebhookRow({ webhook, scope, canManage, onEdit, onConfirm }: {
  webhook: Webhook
  scope: WebhookScope
  canManage: boolean
  onEdit: () => void
  onConfirm: (kind: "delete" | "rotate") => void
}) {
  const client = useAppQueryClient()
  const [showDeliveries, setShowDeliveries] = useState(false)
  const name = webhook.description || webhook.urlDisplay
  const format = webhookFormatOf(webhook)
  const digest = digestScheduleText(webhook)
  const refresh = () => {
    void client.invalidateQueries({ queryKey: webhookKeys.forScope(scope) })
    void client.invalidateQueries({ queryKey: ["ol", "webhooks", webhook.id, "deliveries"] })
  }
  const toggle = useMutation({
    mutationFn: () => updateWebhook(webhook.id, { active: !webhook.active }),
    onSuccess: (next) => {
      refresh()
      toast.success(next.active ? "Webhook turned on" : "Webhook turned off", next.active ? { description: "Deliveries are sent again; you are now its owner." } : undefined)
    },
    onError: (error) => toastApiError(error, { fallbackMessage: webhook.active ? "Couldn't turn the webhook off" : "Couldn't turn the webhook on" }),
  }, client)
  const ping = useMutation({
    mutationFn: () => pingWebhook(webhook.id),
    onSuccess: (result) => {
      refresh()
      if (result.status === "succeeded") toast.success(`Test ping delivered (${result.lastStatusCode ?? "2xx"}${result.lastDurationMs !== null ? `, ${result.lastDurationMs} ms` : ""})`)
      else toast.error("Test ping failed", { description: result.lastError ?? `HTTP ${result.lastStatusCode ?? "?"}` })
    },
    onError: (error) => toastApiError(error, { fallbackMessage: "Couldn't send the test ping" }),
  }, client)
  const reason = disabledReasonText(webhook)

  return (
    <li aria-label={`Webhook ${name}`} className="border-t border-linear-border first:border-t-0">
      <div className="flex flex-wrap items-start gap-3 px-3 py-2.5">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", webhook.active ? (webhook.consecutiveFailures > 0 ? "bg-warning" : "bg-success") : "bg-linear-text-tertiary")} aria-hidden="true" />
            <span className="truncate font-mono text-xs text-linear-text" title={webhook.url ?? webhook.urlDisplay}>{webhook.url ?? webhook.urlDisplay}</span>
            {format !== "openlinear" && (
              <span className="shrink-0 rounded-sm border border-linear-border px-1 text-[10px] text-linear-text-secondary">{WEBHOOK_FORMAT_LABELS[format]}</span>
            )}
          </div>
          {webhook.description && <p className="truncate text-xs text-linear-text-secondary">{webhook.description}</p>}
          <p className="text-[11px] text-linear-text-tertiary">
            {eventSummary(webhook.eventTypes)} · secret {webhook.secretPrefix}…
            {webhook.lastSuccessAt ? ` · last delivered ${formatTime(webhook.lastSuccessAt)}` : ""}
            {webhook.active && webhook.consecutiveFailures > 0 ? ` · ${webhook.consecutiveFailures} failed in a row` : ""}
          </p>
          {digest && (
            <p className="text-[11px] text-linear-text-tertiary">
              {digest}{webhook.active && webhook.digestNextAt ? ` · next ${formatTime(webhook.digestNextAt)}` : ""}
            </p>
          )}
          {reason && <p role="note" className="text-[11px] text-warning">{reason}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-0.5">
          {canManage && (
            <label className="mr-1 inline-flex items-center gap-1.5 text-[11px] text-linear-text-secondary">
              <input
                type="checkbox"
                role="switch"
                aria-checked={webhook.active}
                aria-label={`Send events to ${name}`}
                checked={webhook.active}
                disabled={toggle.isPending}
                onChange={() => toggle.mutate()}
              />
              {webhook.active ? "On" : "Off"}
            </label>
          )}
          {canManage && (
            <button type="button" className={actionClass} disabled={ping.isPending} onClick={() => ping.mutate()} aria-label={`Send a test ping to ${name}`}>
              {ping.isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <Send className="h-3 w-3" aria-hidden="true" />}
              Test ping
            </button>
          )}
          <button type="button" className={actionClass} aria-expanded={showDeliveries} onClick={() => setShowDeliveries(!showDeliveries)} aria-label={`Deliveries of ${name}`}>
            <History className="h-3 w-3" aria-hidden="true" />
            Deliveries
          </button>
          {canManage && (
            <>
              <button type="button" className={actionClass} onClick={onEdit} aria-label={`Edit ${name}`}>
                <Pencil className="h-3 w-3" aria-hidden="true" />
                Edit
              </button>
              <button type="button" className={actionClass} onClick={() => onConfirm("rotate")} aria-label={`Rotate the secret of ${name}`}>
                <KeyRound className="h-3 w-3" aria-hidden="true" />
                Rotate secret
              </button>
              <button type="button" className={cn(actionClass, "hover:text-destructive")} onClick={() => onConfirm("delete")} aria-label={`Delete ${name}`}>
                <Trash2 className="h-3 w-3" aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      </div>
      {showDeliveries && <WebhookDeliveries webhookId={webhook.id} canManage={canManage} />}
    </li>
  )
}

/** A project's webhooks (project settings). */
export function WebhooksSection({ projectId }: { projectId: string }) {
  return <WebhooksPanel scope={{ kind: "project", projectId }} />
}

/** A workspace's webhooks: events of every project in it (Settings → Webhooks). */
export function WorkspaceWebhooksSection({ workspaceId }: { workspaceId: string }) {
  return <WebhooksPanel scope={{ kind: "workspace", workspaceId }} />
}

const SCOPE_COPY: Record<WebhookScope["kind"], { description: string; empty: string; unit: string }> = {
  project: {
    description: "OpenLinear sends each URL the events you pick — signed JSON for your own service, or a message for Slack or Discord — retries failed deliveries with backoff (1 min to 12 h, six attempts) and keeps 30 days of history.",
    empty: "No webhooks yet. Add one to send issue, run, plan and schedule events, or a daily digest, to another service or a Slack or Discord channel.",
    unit: "project",
  },
  workspace: {
    description: "Webhooks here get the events you pick from every project in this workspace (projects their owner can't see are skipped) — signed JSON, or a message for Slack or Discord — with the same retries and 30 days of history as project webhooks.",
    empty: "No workspace webhooks yet. Add one to send events from all projects, or one daily digest for the whole workspace, to another service or a channel.",
    unit: "workspace",
  },
}

function scopeId(scope: WebhookScope): string {
  return scope.kind === "project" ? scope.projectId : scope.workspaceId
}

function WebhooksPanel({ scope }: { scope: WebhookScope }) {
  const client = useAppQueryClient()
  const list = useQuery({
    queryKey: webhookKeys.forScope(scope),
    queryFn: () => (scope.kind === "project" ? fetchProjectWebhooks(scope.projectId) : fetchWorkspaceWebhooks(scope.workspaceId)),
    enabled: Boolean(scopeId(scope)),
  }, client)
  const [editing, setEditing] = useState<{ kind: "new" } | { kind: "edit"; webhook: Webhook } | null>(null)
  const [secret, setSecret] = useState<{ value: string; rotated: boolean; format: WebhookFormat } | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const refresh = () => void client.invalidateQueries({ queryKey: webhookKeys.forScope(scope) })
  const copy = SCOPE_COPY[scope.kind]

  const rotate = useMutation({
    mutationFn: (webhook: Webhook) => rotateWebhookSecret(webhook.id),
    onSuccess: (result) => {
      refresh()
      setSecret({ value: result.secret, rotated: true, format: webhookFormatOf(result) })
    },
    onError: (error) => toastApiError(error, { fallbackMessage: "Couldn't rotate the secret" }),
  }, client)
  const remove = useMutation({
    mutationFn: (webhook: Webhook) => deleteWebhook(webhook.id),
    onSuccess: () => {
      refresh()
      toast.success("Webhook deleted")
    },
    onError: (error) => toastApiError(error, { fallbackMessage: "Couldn't delete the webhook" }),
  }, client)

  const items = list.data?.items ?? []
  const canManage = list.data?.canManage ?? false
  const atLimit = list.data ? items.length >= list.data.limits.endpoints : false

  return (
    <SettingsSection
      title={scope.kind === "workspace" ? "Workspace webhooks" : "Webhooks"}
      description={copy.description}
      icon={<WebhookIcon className="h-4 w-4" />}
      actions={canManage && editing === null ? (
        <Button size="sm" variant="outline" disabled={atLimit} onClick={() => { setSecret(null); setEditing({ kind: "new" }) }} title={atLimit ? `A ${copy.unit} can have ${list.data?.limits.endpoints} webhooks` : undefined}>
          <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Add webhook
        </Button>
      ) : undefined}
    >
      <SettingsPanel className="max-w-3xl">
        {secret && <WebhookSecretNotice secret={secret.value} rotated={secret.rotated} format={secret.format} onDone={() => setSecret(null)} />}
        {editing !== null && (
          <div className="border-b border-linear-border">
            <WebhookForm
              scope={scope}
              webhook={editing.kind === "edit" ? editing.webhook : undefined}
              onCancel={() => setEditing(null)}
              onCreated={(created) => {
                setEditing(null)
                setSecret({ value: created.secret, rotated: false, format: webhookFormatOf(created) })
              }}
              onSaved={() => setEditing(null)}
            />
          </div>
        )}
        {list.isLoading ? (
          <p className="p-4 text-xs text-linear-text-tertiary">Loading webhooks…</p>
        ) : list.isError ? (
          <p role="alert" className="p-4 text-xs text-linear-text-secondary">{describeApiError(list.error, "Couldn't load the webhooks.").message}</p>
        ) : items.length === 0 ? (
          <p className="p-4 text-xs text-linear-text-tertiary">
            {canManage ? copy.empty : "No webhooks. Workspace owners and admins can add them."}
          </p>
        ) : (
          <ul aria-label="Webhooks">
            {items.map((webhook) => (
              <WebhookRow
                key={webhook.id}
                webhook={webhook}
                scope={scope}
                canManage={canManage}
                onEdit={() => { setSecret(null); setEditing({ kind: "edit", webhook }) }}
                onConfirm={(kind) => setConfirm({ kind, webhook })}
              />
            ))}
          </ul>
        )}
        {!canManage && items.length > 0 && (
          <p role="note" className="border-t border-linear-border px-3 py-2 text-[11px] text-linear-text-tertiary">Only workspace owners and admins can change webhooks; URLs are shortened for everyone else.</p>
        )}
      </SettingsPanel>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "rotate" ? "Rotate the signing secret?" : "Delete this webhook?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "rotate"
                ? "You get a new secret, shown once. The current one keeps signing deliveries for 24 hours so you can update the receiver."
                : "Events stop immediately and its delivery history is deleted. The receiver keeps what it already got."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!confirm) return
                if (confirm.kind === "rotate") rotate.mutate(confirm.webhook)
                else remove.mutate(confirm.webhook)
                setConfirm(null)
              }}
            >
              {confirm?.kind === "rotate" ? "Rotate secret" : "Delete webhook"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  )
}
