"use client"

import { useState } from "react"
import { Check, Clipboard, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { WEBHOOK_FORMAT_LABELS, type WebhookFormat } from "@/lib/api/webhooks"

/**
 * FE-14: the signing secret, shown once after creating a webhook or
 * rotating its secret (Slack / Discord webhooks get it too, though those
 * receivers ignore it). It is never shown again; receivers verify
 * `OpenLinear-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>`.
 */
export function WebhookSecretNotice({ secret, rotated, format = "openlinear", onDone }: { secret: string; rotated: boolean; format?: WebhookFormat; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <section aria-label="Signing secret" className="space-y-3 border-b border-linear-border p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-linear-text">
        <KeyRound className="h-4 w-4 text-linear-text-tertiary" aria-hidden="true" />
        {rotated ? "New signing secret" : "Signing secret"}
      </div>
      <p className="text-xs text-linear-text-secondary">
        Copy it now: it won&apos;t be shown again.{" "}
        {rotated ? "The previous secret also signs deliveries for the next 24 hours, so you can update the receiver without dropping any." : "Your receiver uses it to check that a delivery came from OpenLinear."}
      </p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          aria-label="Secret value"
          value={secret}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-sm border border-linear-border bg-linear-bg px-2 py-1.5 font-mono text-xs text-linear-text"
        />
        <Button type="button" size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> : <Clipboard className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? "Copied" : "Copy secret"}
        </Button>
      </div>
      {format !== "openlinear" && (
        <p role="note" className="text-[11px] leading-5 text-linear-text-secondary">
          {WEBHOOK_FORMAT_LABELS[format]} doesn&apos;t check signatures, so you can skip this for the channel itself. Keep the secret if you later point the webhook at your own service.
        </p>
      )}
      <p className="text-[11px] leading-5 text-linear-text-tertiary">
        Verify each request: compute HMAC-SHA256 of <code>{"<OpenLinear-Timestamp>.<raw body>"}</code> with this secret and compare it to a <code>v1=</code> value of <code>OpenLinear-Signature</code>; reject timestamps older than 5 minutes and skip delivery ids (<code>OpenLinear-Delivery</code>) you already handled.
      </p>
      <div className="flex justify-end">
        <Button type="button" size="sm" onClick={onDone}>I&apos;ve saved it</Button>
      </div>
    </section>
  )
}
