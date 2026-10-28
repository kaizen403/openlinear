"use client"

import { useId, useRef, useState, type FormEvent } from "react"
import { useMutation } from "@tanstack/react-query"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { describeApiError, isApiErrorCode } from "@/lib/api/errors"
import { createIdempotencyKey } from "@/lib/api/idempotency"
import {
  createKnowledge,
  KNOWLEDGE_KIND_LABEL,
  updateKnowledge,
  type KnowledgeDraft,
  type KnowledgeEntry,
  type KnowledgeKind,
  type KnowledgeSourceRef,
} from "@/lib/api/knowledge"
import { queryKeys } from "@/lib/query/keys"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"
import { cn } from "@/lib/utils"

/**
 * W19b / FE-13: write or edit a knowledge entry. A new entry from a person
 * is active at once (agents get it from their next run); an edit is a new
 * revision based on the one opened (a conflict reloads instead of
 * overwriting).
 */

export const MAX_TITLE = 120
export const MAX_BODY = 4_000
const KINDS: KnowledgeKind[] = ["convention", "procedure", "note"]
const KIND_HINT: Record<KnowledgeKind, string> = {
  convention: "A rule the code follows (naming, tools, style).",
  procedure: "Steps to do something (release, migrate, run tests).",
  note: "Context worth knowing (pitfalls, decisions, links).",
}
const EXPIRY_CHOICES = [
  { value: "keep", label: "Keep the current expiry" },
  { value: "never", label: "Never expires" },
  { value: "30", label: "Expires in 30 days" },
  { value: "90", label: "Expires in 90 days" },
  { value: "365", label: "Expires in a year" },
] as const
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number]["value"]

/** The ISO expiry for a choice (undefined = unchanged). */
export function expiryFor(choice: ExpiryChoice, now: number = Date.now()): string | null | undefined {
  if (choice === "keep") return undefined
  if (choice === "never") return null
  return new Date(now + Number(choice) * 86_400_000).toISOString()
}

export function KnowledgeForm({ projectId, entry, initial, onCancel, onSaved }: {
  projectId: string
  /** Edit this entry (a new revision); absent = a new entry. */
  entry?: KnowledgeEntry
  /** Prefill for a new entry (e.g. from a review finding) and its provenance. */
  initial?: Partial<Pick<KnowledgeDraft, "kind" | "title" | "body">> & { sourceRef?: KnowledgeSourceRef }
  onCancel: () => void
  onSaved: (entry: KnowledgeEntry) => void
}) {
  const client = useAppQueryClient()
  const id = useId()
  const [kind, setKind] = useState<KnowledgeKind>(entry?.kind ?? initial?.kind ?? "convention")
  const [title, setTitle] = useState(entry?.title ?? initial?.title ?? "")
  const [body, setBody] = useState(entry?.body ?? initial?.body ?? "")
  const [expiry, setExpiry] = useState<ExpiryChoice>(entry ? "keep" : "never")
  const key = useRef(createIdempotencyKey())

  const save = useMutation({
    mutationFn: () => {
      const expiresAt = expiryFor(expiry)
      if (entry) {
        return updateKnowledge(entry.id, {
          baseVersion: entry.version,
          kind,
          title: title.trim(),
          body: body.trim(),
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        })
      }
      return createKnowledge(projectId, {
        kind,
        title: title.trim(),
        body: body.trim(),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(initial?.sourceRef ? { sourceRef: initial.sourceRef } : {}),
      }, key.current)
    },
    onSuccess: (saved) => {
      void client.invalidateQueries({ queryKey: queryKeys.knowledge.list(projectId) })
      void client.invalidateQueries({ queryKey: queryKeys.knowledge.detail(saved.id) })
      onSaved(saved)
    },
    onError: (error) => {
      if (isApiErrorCode(error, "KNOWLEDGE_VERSION_CONFLICT")) void client.invalidateQueries({ queryKey: queryKeys.knowledge.list(projectId) })
    },
  }, client)

  const valid = title.trim().length > 0 && title.trim().length <= MAX_TITLE && body.trim().length > 0 && body.trim().length <= MAX_BODY
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid && !save.isPending) save.mutate()
  }
  const error = save.error ? describeApiError(save.error, entry ? "Couldn't save the entry." : "Couldn't add the entry.") : null

  return (
    <form onSubmit={submit} className="space-y-4" aria-label={entry ? `Edit ${entry.title}` : "New knowledge entry"}>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium text-linear-text">Kind</legend>
        <div role="radiogroup" className="flex gap-1">
          {KINDS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => setKind(value)}
              className={cn("h-7 rounded-sm border px-2.5 text-xs", kind === value ? "border-linear-accent bg-linear-accent/10 text-linear-text" : "border-linear-border text-linear-text-secondary hover:text-linear-text", focusRing)}
            >
              {KNOWLEDGE_KIND_LABEL[value]}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-linear-text-tertiary">{KIND_HINT[kind]}</p>
      </fieldset>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-title`} className="text-xs font-medium text-linear-text">Title</label>
        <input
          id={`${id}-title`}
          value={title}
          maxLength={MAX_TITLE}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Use pnpm, never npm or yarn"
          className={cn("h-8 w-full rounded-sm border border-linear-border bg-linear-bg px-2 text-sm text-linear-text", focusRing)}
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <label htmlFor={`${id}-body`} className="text-xs font-medium text-linear-text">What agents should know</label>
          <span className={cn("text-[11px]", body.trim().length > MAX_BODY ? "text-danger" : "text-linear-text-tertiary")}>{body.trim().length} / {MAX_BODY}</span>
        </div>
        <textarea
          id={`${id}-body`}
          value={body}
          rows={8}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Install with pnpm install --ignore-scripts. Lockfile changes go in their own commit."
          className={cn("w-full rounded-sm border border-linear-border bg-linear-bg px-2 py-1.5 text-sm text-linear-text", focusRing)}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-expiry`} className="text-xs font-medium text-linear-text">Expiry</label>
        <select
          id={`${id}-expiry`}
          value={expiry}
          onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}
          className={cn("h-8 rounded-sm border border-linear-border bg-linear-bg px-2 text-sm text-linear-text", focusRing)}
        >
          {EXPIRY_CHOICES.filter((choice) => entry || choice.value !== "keep").map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.value === "keep" && entry?.expiresAt ? `Keep: expires ${new Date(entry.expiresAt).toLocaleDateString()}` : choice.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-linear-text-tertiary">Expired entries are kept but no longer given to runs.</p>
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error.message}{error.hint ? ` ${error.hint}` : ""}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={!valid || save.isPending}>
          {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {entry ? "Save as a new revision" : "Add for every run"}
        </Button>
      </div>
    </form>
  )
}
