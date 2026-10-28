"use client"

import { useState } from "react"
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, Loader2, RotateCcw } from "lucide-react"
import { focusRing } from "@/components/ui/focus-ring"
import { describeApiError, toastApiError } from "@/lib/api/errors"
import {
  deliveryStatusText,
  eventTypeLabel,
  fetchWebhookDeliveries,
  fetchWebhookDelivery,
  formatTime,
  prettyPayload,
  redeliverWebhookDelivery,
  webhookKeys,
  type WebhookDelivery,
  type WebhookDeliveryStatus,
} from "@/lib/api/webhooks"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * FE-14: a webhook's delivery history, newest first — event, status (or
 * when the next retry is due), response code, attempts — with the exact
 * body sent and "Redeliver" (same delivery id, attempted right away).
 */

const PAGE_SIZE = 20
const FILTERS: ReadonlyArray<{ value: WebhookDeliveryStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Retrying" },
  { value: "succeeded", label: "Delivered" },
]

const STATUS_CLASS: Record<WebhookDeliveryStatus, string> = {
  succeeded: "text-success",
  pending: "text-warning",
  failed: "text-destructive",
  abandoned: "text-linear-text-tertiary",
}

const actionClass = cn("inline-flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] text-linear-text-secondary hover:bg-linear-bg-tertiary hover:text-linear-text disabled:opacity-50", focusRing)

function DeliveryBody({ webhookId, deliveryId }: { webhookId: string; deliveryId: string }) {
  const client = useAppQueryClient()
  const detail = useQuery({
    queryKey: webhookKeys.delivery(webhookId, deliveryId),
    queryFn: () => fetchWebhookDelivery(webhookId, deliveryId),
  }, client)
  if (detail.isLoading) return <p className="text-xs text-linear-text-tertiary">Loading…</p>
  if (detail.isError || !detail.data) return <p role="alert" className="text-xs text-linear-text-secondary">{describeApiError(detail.error, "Couldn't load the delivery.").message}</p>
  return (
    <div className="space-y-2">
      <div>
        <p className="text-[11px] text-linear-text-tertiary">Request body</p>
        <figure aria-label="Request body" className="m-0">
          <pre className="max-h-64 overflow-auto rounded-sm bg-linear-bg p-2 text-[11px] text-linear-text">{prettyPayload(detail.data.payload)}</pre>
        </figure>
      </div>
      {(detail.data.lastResponseExcerpt || detail.data.lastError) && (
        <div>
          <p className="text-[11px] text-linear-text-tertiary">Last response</p>
          <figure aria-label="Last response" className="m-0">
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap rounded-sm bg-linear-bg p-2 text-[11px] text-linear-text">
              {[detail.data.lastError, detail.data.lastResponseExcerpt].filter(Boolean).join("\n")}
            </pre>
          </figure>
        </div>
      )}
    </div>
  )
}

function DeliveryRow({ webhookId, delivery, canManage, onRedelivered }: {
  webhookId: string
  delivery: WebhookDelivery
  canManage: boolean
  onRedelivered: () => void
}) {
  const client = useAppQueryClient()
  const [open, setOpen] = useState(false)
  const redeliver = useMutation({
    mutationFn: () => redeliverWebhookDelivery(webhookId, delivery.id),
    onSuccess: (result) => {
      onRedelivered()
      void client.invalidateQueries({ queryKey: webhookKeys.delivery(webhookId, delivery.id) })
      if (result.status === "succeeded") toast.success(`Redelivered (${result.lastStatusCode ?? "2xx"})`)
      else toast.error("Redelivery failed", { description: result.lastError ?? `HTTP ${result.lastStatusCode ?? "?"}` })
    },
    onError: (error) => toastApiError(error, { fallbackMessage: "Couldn't redeliver" }),
  }, client)
  const label = eventTypeLabel(delivery.eventType)
  return (
    <>
      <tr aria-label={`Delivery ${label}`} className="border-t border-linear-border align-top">
        <td className="py-1.5 pr-2">
          <button type="button" className={actionClass} aria-expanded={open} aria-label={`${open ? "Hide" : "Show"} the body of ${label}`} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown className="h-3 w-3" aria-hidden="true" /> : <ChevronRight className="h-3 w-3" aria-hidden="true" />}
            <span className="text-linear-text">{label}</span>
          </button>
        </td>
        <td className={cn("py-1.5 pr-2 text-xs", STATUS_CLASS[delivery.status])}>{deliveryStatusText(delivery)}</td>
        <td className="py-1.5 pr-2 text-xs text-linear-text-secondary" title={delivery.lastError ?? undefined}>
          {delivery.lastStatusCode ?? (delivery.lastError ? "—" : "")}
        </td>
        <td className="py-1.5 pr-2 text-xs text-linear-text-secondary">{delivery.attempts}/{delivery.maxAttempts}</td>
        <td className="py-1.5 pr-2 text-xs text-linear-text-tertiary">{formatTime(delivery.lastAttemptAt ?? delivery.createdAt)}</td>
        <td className="py-1.5 text-right">
          {canManage && (
            <button type="button" className={actionClass} disabled={redeliver.isPending || delivery.inFlight} onClick={() => redeliver.mutate()} aria-label={`Redeliver ${label}`}>
              {redeliver.isPending ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-3 w-3" aria-hidden="true" />}
              Redeliver
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="pb-2"><DeliveryBody webhookId={webhookId} deliveryId={delivery.id} /></td>
        </tr>
      )}
    </>
  )
}

export function WebhookDeliveries({ webhookId, canManage }: { webhookId: string; canManage: boolean }) {
  const client = useAppQueryClient()
  const [status, setStatus] = useState<WebhookDeliveryStatus | "all">("all")
  const deliveries = useInfiniteQuery({
    queryKey: webhookKeys.deliveries(webhookId, status),
    queryFn: ({ pageParam }) => fetchWebhookDeliveries(webhookId, { cursor: pageParam, limit: PAGE_SIZE, ...(status === "all" ? {} : { status }) }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // Watch retries and in-flight sends while the panel is open.
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.items.some((item) => item.status === "pending")) ? 5_000 : false),
  }, client)
  const items = deliveries.data?.pages.flatMap((page) => page.items) ?? []
  const refresh = () => void client.invalidateQueries({ queryKey: ["ol", "webhooks", webhookId, "deliveries"] })

  return (
    <div className="space-y-2 border-t border-linear-border bg-linear-bg-secondary/40 px-3 py-2">
      <fieldset className="m-0 flex items-center gap-1 border-0 p-0" aria-label="Filter deliveries">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            aria-pressed={status === filter.value}
            className={cn(actionClass, status === filter.value && "bg-linear-bg-tertiary text-linear-text")}
            onClick={() => setStatus(filter.value)}
          >
            {filter.label}
          </button>
        ))}
      </fieldset>
      {deliveries.isLoading ? (
        <p className="text-xs text-linear-text-tertiary">Loading deliveries…</p>
      ) : deliveries.isError ? (
        <p role="alert" className="text-xs text-linear-text-secondary">{describeApiError(deliveries.error, "Couldn't load the deliveries.").message}</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-linear-text-tertiary">{status === "all" ? "No deliveries yet. Send a test ping to try the receiver." : "No deliveries match this filter."}</p>
      ) : (
        <table className="w-full text-left" aria-label="Deliveries">
          <thead>
            <tr className="text-[11px] text-linear-text-tertiary">
              <th className="pb-1 font-normal">Event</th>
              <th className="pb-1 font-normal">Status</th>
              <th className="pb-1 font-normal">Response</th>
              <th className="pb-1 font-normal">Attempts</th>
              <th className="pb-1 font-normal">Last try</th>
              <th className="pb-1" />
            </tr>
          </thead>
          <tbody>
            {items.map((delivery) => (
              <DeliveryRow key={delivery.id} webhookId={webhookId} delivery={delivery} canManage={canManage} onRedelivered={refresh} />
            ))}
          </tbody>
        </table>
      )}
      {deliveries.hasNextPage && (
        <button type="button" className={actionClass} disabled={deliveries.isFetchingNextPage} onClick={() => void deliveries.fetchNextPage()}>
          {deliveries.isFetchingNextPage ? "Loading…" : "Load older deliveries"}
        </button>
      )}
    </div>
  )
}
