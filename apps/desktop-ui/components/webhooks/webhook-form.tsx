"use client"

import { useId, useMemo, useRef, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { ApiError } from "@/lib/api/fetch"
import { describeApiError, toastApiError } from "@/lib/api/errors"
import { IdempotencyIntent } from "@/lib/api/idempotency"
import {
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_FORMATS,
  WEBHOOK_FORMAT_HELP,
  WEBHOOK_FORMAT_LABELS,
  WEBHOOK_FORMAT_PLACEHOLDERS,
  createProjectWebhook,
  createWorkspaceWebhook,
  deviceTimeZone,
  hourLabel,
  timeZoneOptions,
  updateWebhook,
  webhookFormatOf,
  webhookKeys,
  webhookUrlHint,
  type Webhook,
  type WebhookEventType,
  type WebhookFormat,
  type WebhookInput,
  type WebhookScope,
  type WebhookWithSecret,
} from "@/lib/api/webhooks"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-14: add or edit a webhook — the HTTPS URL OpenLinear POSTs to, what it
 * sends (signed OpenLinear JSON, or a Slack / Discord message), a note, the
 * events it receives and, for the daily digest, the hour and time zone.
 * Creating answers with the signing secret (shown once by the caller);
 * saving makes you the webhook's owner.
 */

export interface WebhookDraft {
  url: string
  description: string
  eventTypes: WebhookEventType[]
  format: WebhookFormat
  digestHour: number
  digestTimezone: string
}

export function emptyWebhookDraft(timezone = deviceTimeZone()): WebhookDraft {
  return { url: "", description: "", eventTypes: ["issue.created", "issue.done", "run.failed"], format: "openlinear", digestHour: 9, digestTimezone: timezone }
}

function isEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value)
}

export function draftFromWebhook(webhook: Webhook, timezone = deviceTimeZone()): WebhookDraft {
  return {
    url: webhook.url ?? "",
    description: webhook.description ?? "",
    eventTypes: webhook.eventTypes.filter(isEventType),
    format: webhookFormatOf(webhook),
    digestHour: webhook.digestHour ?? 9,
    digestTimezone: webhook.digestTimezone ?? timezone,
  }
}

/** The request body, or null while the draft can't be sent (no URL, no events, a URL the server would refuse). */
export function draftToWebhookInput(draft: WebhookDraft): WebhookInput | null {
  const url = draft.url.trim()
  const description = draft.description.trim()
  if (!url || webhookUrlHint(url, draft.format) || draft.eventTypes.length === 0 || description.length > 200) return null
  const eventTypes = WEBHOOK_EVENT_TYPES.filter((type) => draft.eventTypes.includes(type))
  const digest = eventTypes.includes("digest.daily") ? { digestHour: draft.digestHour, digestTimezone: draft.digestTimezone } : {}
  return { url, description: description || null, eventTypes, format: draft.format, ...digest }
}

const inputClass = cn("h-8 w-full rounded-sm border border-linear-border bg-linear-bg px-2 text-sm text-linear-text placeholder:text-linear-text-tertiary", focusRing)
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

export function WebhookForm({ scope, webhook, onCancel, onCreated, onSaved }: {
  scope: WebhookScope
  webhook?: Webhook
  onCancel: () => void
  onCreated?: (created: WebhookWithSecret) => void
  onSaved?: (saved: Webhook) => void
}) {
  const client = useAppQueryClient()
  const [draft, setDraft] = useState<WebhookDraft>(() => (webhook ? draftFromWebhook(webhook) : emptyWebhookDraft()))
  const [serverProblem, setServerProblem] = useState<string | null>(null)
  const intent = useRef(new IdempotencyIntent())
  const urlId = useId()
  const descriptionId = useId()
  const hourId = useId()
  const zoneId = useId()
  const hint = webhookUrlHint(draft.url, draft.format)
  const input = draftToWebhookInput(draft)
  const zones = useMemo(() => timeZoneOptions(draft.digestTimezone), [draft.digestTimezone])
  const wantsDigest = draft.eventTypes.includes("digest.daily")

  const save = useMutation({
    mutationFn: async (body: WebhookInput): Promise<{ created: WebhookWithSecret | null; saved: Webhook }> => {
      if (webhook) return { created: null, saved: await updateWebhook(webhook.id, body) }
      const key = intent.current.keyFor(JSON.stringify(body))
      const created = scope.kind === "project" ? await createProjectWebhook(scope.projectId, body, key) : await createWorkspaceWebhook(scope.workspaceId, body, key)
      return { created, saved: created }
    },
    onSuccess: ({ created, saved }) => {
      intent.current.complete()
      setServerProblem(null)
      void client.invalidateQueries({ queryKey: webhookKeys.forScope(scope) })
      if (created) onCreated?.(created)
      else {
        toast.success("Webhook saved")
        onSaved?.(saved)
      }
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError && error.code === "WEBHOOK_URL_INVALID") {
        const described = describeApiError(error)
        setServerProblem(described.hint ? `${described.message}. ${described.hint}` : described.message)
        return
      }
      toastApiError(error, { fallbackMessage: webhook ? "Couldn't save the webhook" : "Couldn't add the webhook" })
    },
  }, client)

  const toggle = (type: WebhookEventType) => setDraft((current) => ({
    ...current,
    eventTypes: current.eventTypes.includes(type) ? current.eventTypes.filter((item) => item !== type) : [...current.eventTypes, type],
  }))

  return (
    <form
      aria-label={webhook ? "Edit webhook" : "Add webhook"}
      className="space-y-4 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (input) save.mutate(input)
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-xs text-linear-text-secondary">Send as</legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
          {WEBHOOK_FORMATS.map((format) => (
            <label key={format} className={cn("flex cursor-pointer flex-col gap-0.5 rounded-sm border px-2.5 py-2", draft.format === format ? "border-linear-accent bg-linear-bg-tertiary" : "border-linear-border")}>
              <span className="flex items-center gap-2 text-sm text-linear-text">
                <input
                  type="radio"
                  name={`${urlId}-format`}
                  value={format}
                  checked={draft.format === format}
                  onChange={() => {
                    setServerProblem(null)
                    setDraft({ ...draft, format })
                  }}
                />
                {WEBHOOK_FORMAT_LABELS[format]}
              </span>
              <span className="text-[11px] leading-4 text-linear-text-tertiary">{WEBHOOK_FORMAT_HELP[format]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1">
        <label htmlFor={urlId} className="text-xs text-linear-text-secondary">{draft.format === "openlinear" ? "Payload URL" : `${WEBHOOK_FORMAT_LABELS[draft.format]} webhook URL`}</label>
        <input
          id={urlId}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={WEBHOOK_FORMAT_PLACEHOLDERS[draft.format]}
          className={inputClass}
          value={draft.url}
          onChange={(event) => {
            setServerProblem(null)
            setDraft({ ...draft, url: event.target.value })
          }}
          aria-invalid={Boolean(hint || serverProblem)}
        />
        {(hint || serverProblem) && <p role="alert" className="text-xs text-destructive">{serverProblem ?? hint}</p>}
        {webhook && <p className="text-[11px] text-linear-text-tertiary">Changing the URL keeps the secret; deliveries already queued go to the new URL.</p>}
      </div>
      <div className="space-y-1">
        <label htmlFor={descriptionId} className="text-xs text-linear-text-secondary">Description (optional)</label>
        <input
          id={descriptionId}
          maxLength={200}
          placeholder="What receives these events"
          className={inputClass}
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs text-linear-text-secondary">Events</legend>
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {WEBHOOK_EVENT_TYPES.map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm text-linear-text">
              <input type="checkbox" checked={draft.eventTypes.includes(type)} onChange={() => toggle(type)} />
              <span>{WEBHOOK_EVENT_LABELS[type]}</span>
              <code className="text-[11px] text-linear-text-tertiary">{type}</code>
            </label>
          ))}
        </div>
        {draft.eventTypes.length === 0 && <p className="text-xs text-linear-text-tertiary">Pick at least one event.</p>}
      </fieldset>
      {wantsDigest && (
        <fieldset className="space-y-2">
          <legend className="text-xs text-linear-text-secondary">Daily digest</legend>
          <p className="text-[11px] leading-4 text-linear-text-tertiary">
            Once a day: issues created, completed and blocked, agent runs that succeeded or failed, and plans and knowledge proposals waiting for review{scope.kind === "workspace" ? ", across the workspace's projects" : ""}.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label htmlFor={hourId} className="text-xs text-linear-text-secondary">Send at</label>
              <select
                id={hourId}
                className={cn(inputClass, "w-28")}
                value={draft.digestHour}
                onChange={(event) => setDraft({ ...draft, digestHour: Number(event.target.value) })}
              >
                {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
              </select>
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <label htmlFor={zoneId} className="text-xs text-linear-text-secondary">Time zone</label>
              <select
                id={zoneId}
                className={inputClass}
                value={draft.digestTimezone}
                onChange={(event) => setDraft({ ...draft, digestTimezone: event.target.value })}
              >
                {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </div>
          </div>
        </fieldset>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!input || save.isPending}>
          {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {webhook ? "Save changes" : "Add webhook"}
        </Button>
      </div>
    </form>
  )
}
