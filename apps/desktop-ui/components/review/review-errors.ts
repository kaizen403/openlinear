import { ApiError, AuthExpiredError, NetworkError } from "@/lib/api/fetch"
import { describeApiError } from "@/lib/api/errors"

/**
 * Review-loop copy layered over lib/api/errors.ts: the codes below are
 * specific to the diff, follow-up and run-state routes; everything else falls
 * through to the shared map (SANDBOX_UNAVAILABLE, VALIDATION_ERROR, …).
 *
 * A 404 *without* a code is Express's default "route not found": the local
 * execution service predates the route, so the fix is updating the app.
 */

export type ReviewErrorContext = "diff" | "follow-up" | "run"

export type ReviewErrorKind =
  | "route_missing"
  | "workspace_missing"
  | "unsafe_workspace"
  | "forbidden"
  | "run_active"
  | "unsupported"
  | "offline"
  | "invalid"
  | "other"

export interface ReviewErrorView {
  kind: ReviewErrorKind
  code: string | null
  title: string
  hint?: string
  retryable: boolean
}

const ACTION: Readonly<Record<ReviewErrorContext, string>> = {
  diff: "show the agent's changes",
  "follow-up": "send review follow-ups to the agent",
  run: "report run checks",
}

export function isRouteMissing(error: unknown): boolean {
  return error instanceof ApiError && !(error instanceof AuthExpiredError) && error.status === 404 && !error.code
}

function detailKeys(error: ApiError): string[] {
  const details = error.details
  if (!details || typeof details !== "object" || Array.isArray(details)) return []
  const keys = (details as { keys?: unknown }).keys
  return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string").slice(0, 8) : []
}

export function describeReviewError(error: unknown, context: ReviewErrorContext): ReviewErrorView {
  if (isRouteMissing(error)) {
    return {
      kind: "route_missing",
      code: null,
      title: "Update OpenLinear to use this",
      hint: `This version of the local execution service can't ${ACTION[context]}. Update the desktop app (or restart the local service), then try again.${context === "follow-up" ? " Your drafts are kept." : ""}`,
      retryable: false,
    }
  }
  if (error instanceof NetworkError) {
    return {
      kind: "offline",
      code: "NETWORK_ERROR",
      title: "The local execution service isn't reachable",
      hint: `Make sure the OpenLinear desktop app is running, then retry.${context === "follow-up" ? " Your drafts are kept." : ""}`,
      retryable: true,
    }
  }
  if (error instanceof ApiError && !(error instanceof AuthExpiredError)) {
    switch (error.code) {
      case "DIFF_WORKSPACE_NOT_FOUND":
        return {
          kind: "workspace_missing",
          code: error.code,
          title: "No local changes to review on this device",
          hint: "The agent's workspace for this task isn't on this computer: the task ran elsewhere, or its workspace was cleaned up (they're kept for 24 hours).",
          retryable: false,
        }
      case "GIT_CONFIG_UNSAFE": {
        const keys = detailKeys(error)
        return {
          kind: "unsafe_workspace",
          code: error.code,
          title: "OpenLinear refused to read this workspace",
          hint: `Its git config contains settings that can run programs${keys.length > 0 ? ` (${keys.join(", ")})` : ""}. Inspect the workspace yourself before trusting its changes.`,
          retryable: false,
        }
      }
      case "RUN_PRINCIPAL_MISMATCH":
        return {
          kind: "forbidden",
          code: error.code,
          title: "This run belongs to another account",
          hint: "Only the person who started the run can review its local changes on this device.",
          retryable: false,
        }
      case "INVALID_BASE_REF":
      case "BASE_REF_NOT_FOUND":
        return { kind: "invalid", code: error.code, title: "That base isn't a branch or commit in this repository", hint: "Pick another base, or reset to the run's base.", retryable: false }
      case "DIFF_FAILED":
        return { kind: "other", code: error.code, title: "Couldn't compute the diff", hint: "Try again; if it keeps failing, inspect the workspace with git.", retryable: true }
      case "RUN_ACTIVE":
        return {
          kind: "run_active",
          code: error.code,
          title: "The agent is still working on this task",
          hint: "Wait for the run to finish (or stop it), then send your review. Your drafts are kept.",
          retryable: false,
        }
      case "FOLLOW_UP_UNSUPPORTED":
        return {
          kind: "unsupported",
          code: error.code,
          title: "This run can't take a follow-up",
          hint: `${error.message && !/^Request failed/.test(error.message) ? `${error.message} ` : ""}Start a new run with your feedback in the task description instead. Your drafts are kept.`,
          retryable: false,
        }
      case "TASK_NOT_FOUND":
        return { kind: "invalid", code: error.code, title: "This task no longer exists, or you lost access to it", hint: "Refresh the board.", retryable: false }
      case "CLOUD_API_UNREACHABLE":
      case "CLOUD_API_NOT_CONFIGURED":
        return {
          kind: "offline",
          code: error.code,
          title: "Can't reach OpenLinear to verify your session",
          hint: `Check your connection and retry.${context === "follow-up" ? " Your drafts are kept." : ""}`,
          retryable: true,
        }
    }
  }
  const described = describeApiError(error, context === "diff" ? "Couldn't load the diff." : context === "follow-up" ? "Couldn't send the follow-up." : "Couldn't load the run checks.")
  return {
    kind: described.status === 400 ? "invalid" : described.status === 403 ? "forbidden" : "other",
    code: described.code,
    title: described.message,
    ...(described.hint ? { hint: described.hint } : {}),
    retryable: described.retryable,
  }
}
