"use client"

import { useEffect, useId, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiFetch } from "@/lib/api/fetch"
import { describeApiError } from "@/lib/api/errors"
import { queryKeys } from "@/lib/query/keys"
import { settingsQuery } from "@/lib/query/resources"
import { useAppQueryClient } from "@/lib/query/use-app-query-client"

/**
 * W15a: per-run budgets. A run that reaches either limit is stopped; its work
 * is kept (a follow-up can continue). Empty = no limit. Limits mirror the
 * API (cost 0–10 000 USD, tokens 1 000–1 000 000 000) and apply to runs
 * started after saving (each run seals its budget at start).
 */

export interface BudgetDraft {
  cost: string
  tokens: string
}

export type BudgetParse =
  | { ok: true; body: { maxRunCostUsd: number | null; maxRunTokens: number | null } }
  | { ok: false; problems: string[] }

export function parseBudgets(draft: BudgetDraft): BudgetParse {
  const problems: string[] = []
  const costText = draft.cost.trim().replace(/^\$/, "")
  const tokenText = draft.tokens.trim().replace(/[,_\s]/g, "")
  let cost: number | null = null
  let tokens: number | null = null
  if (costText) {
    cost = Number(costText)
    if (!Number.isFinite(cost) || cost <= 0 || cost > 10_000) problems.push("The cost limit must be more than $0 and at most $10,000.")
  }
  if (tokenText) {
    tokens = Number(tokenText)
    if (!Number.isInteger(tokens) || tokens < 1_000 || tokens > 1_000_000_000) problems.push("The token limit must be a whole number from 1,000 to 1,000,000,000.")
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, body: { maxRunCostUsd: cost, maxRunTokens: tokens } }
}

export function budgetDraftFrom(settings: Record<string, unknown> | undefined): BudgetDraft {
  const cost = settings?.maxRunCostUsd
  const tokens = settings?.maxRunTokens
  return {
    cost: typeof cost === "number" ? String(cost) : "",
    tokens: typeof tokens === "number" ? String(tokens) : "",
  }
}

export function RunBudgetsCard() {
  const client = useAppQueryClient()
  const settings = useQuery(settingsQuery(), client)
  const [draft, setDraft] = useState<BudgetDraft>({ cost: "", tokens: "" })
  const [problems, setProblems] = useState<string[]>([])
  const costId = useId()
  const tokensId = useId()

  useEffect(() => {
    if (settings.data) setDraft(budgetDraftFrom(settings.data))
  }, [settings.data])

  const save = useMutation({
    mutationFn: (body: { maxRunCostUsd: number | null; maxRunTokens: number | null }) =>
      apiFetch<Record<string, unknown>>("/api/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (row) => {
      client.setQueryData(queryKeys.settings(), row)
      toast.success("Run budgets saved")
    },
    onError: (error: unknown) => {
      const described = describeApiError(error, "Couldn't save the run budgets.")
      toast.error(described.message, described.hint ? { description: described.hint } : undefined)
    },
  }, client)

  const submit = () => {
    const parsed = parseBudgets(draft)
    if (!parsed.ok) {
      setProblems(parsed.problems)
      return
    }
    setProblems([])
    save.mutate(parsed.body)
  }

  return (
    <Card className="bg-linear-bg-secondary border-linear-border">
      <CardHeader>
        <CardTitle className="text-linear-text">Run budgets</CardTitle>
        <CardDescription className="text-linear-text-secondary">
          Stop a run when it reaches a cost or token limit. Its work is kept, so a follow-up can continue. Leave empty for no limit; applies to runs started after saving.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={costId} className="text-xs text-linear-text-secondary">Max cost per run (USD)</Label>
            <Input id={costId} inputMode="decimal" placeholder="No limit" value={draft.cost} onChange={(event) => setDraft((current) => ({ ...current, cost: event.target.value }))} className="bg-linear-bg-tertiary border-linear-border" />
            <p className="text-xs text-linear-text-tertiary">Only providers that report cost count toward it.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={tokensId} className="text-xs text-linear-text-secondary">Max tokens per run</Label>
            <Input id={tokensId} inputMode="numeric" placeholder="No limit" value={draft.tokens} onChange={(event) => setDraft((current) => ({ ...current, tokens: event.target.value }))} className="bg-linear-bg-tertiary border-linear-border" />
            <p className="text-xs text-linear-text-tertiary">Input plus output tokens.</p>
          </div>
        </div>
        {problems.length > 0 && (
          <ul role="alert" className="space-y-1 rounded-sm border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {problems.map((problem) => <li key={problem}>{problem}</li>)}
          </ul>
        )}
        <Button size="sm" onClick={submit} disabled={save.isPending || settings.isLoading}>
          {save.isPending ? "Saving..." : "Save run budgets"}
        </Button>
      </CardContent>
    </Card>
  )
}
