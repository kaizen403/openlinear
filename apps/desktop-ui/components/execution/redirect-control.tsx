"use client"

import { useState } from "react"
import { CornerDownRight, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { focusRing } from "@/components/ui/focus-ring"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { toastApiError } from "@/lib/api/errors"
import { redirectTask, type FollowUpResponse } from "@/lib/api/review"
import { cn } from "@/lib/utils"

/**
 * W12 "stop and redirect": while the agent works, send it a new direction.
 * The running turn stops (its work is kept on the branch) and a follow-up
 * turn continues on the same worktree with this instruction.
 */
export function RedirectControl({ taskId, onRedirected, disabled }: { taskId: string; onRedirected?: (response: FollowUpResponse) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState("")
  const [sending, setSending] = useState(false)

  const send = async () => {
    const text = message.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const response = await redirectTask(taskId, text)
      setOpen(false)
      setMessage("")
      toast.success("Redirected", { description: "The agent stopped this turn (work kept) and continues with your instruction." })
      onRedirected?.(response)
    } catch (error) {
      toastApiError(error, { fallbackMessage: "Couldn't redirect the agent" })
    } finally {
      setSending(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled} className="h-8 px-2 sm:px-3 text-linear-text-secondary hover:text-linear-text" aria-label="Redirect the agent">
          <CornerDownRight className="h-3.5 w-3.5 sm:mr-1.5" aria-hidden="true" />
          <span className="hidden sm:inline">Redirect</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 border-linear-border bg-linear-bg-secondary p-3">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
          className="space-y-2"
        >
          <label className="block text-xs text-linear-text-secondary" htmlFor={`redirect-${taskId}`}>
            New direction for the agent. This turn stops (its work is kept) and the agent continues from there.
          </label>
          <textarea
            id={`redirect-${taskId}`}
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault()
                void send()
              }
            }}
            rows={3}
            maxLength={8000}
            placeholder="e.g. Stop refactoring; only fix the null check in auth.ts"
            className={cn("w-full resize-y rounded-sm border border-linear-border bg-linear-bg px-2 py-1.5 text-xs text-linear-text placeholder:text-linear-text-tertiary", focusRing)}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={!message.trim() || sending}>
              {sending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              Stop and redirect
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
