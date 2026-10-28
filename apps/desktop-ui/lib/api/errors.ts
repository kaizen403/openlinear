import { toast } from "sonner"
import { ApiError, AuthExpiredError, NetworkError } from "./fetch"

/**
 * One place that turns API/sidecar error envelopes into actionable copy for
 * board, task and execution toasts.
 *
 * - Known `code`s get a user-facing `message` (what happened) and `hint` (what
 *   to do next). Codes whose server message carries the specifics (validation,
 *   forward-compatible sandbox/persistence codes) keep that message.
 * - Unknown codes fall back to the server message, so new backend codes are
 *   never swallowed.
 * - `retryable` / `retryAfterMs` say whether sending the same request again
 *   (with the same Idempotency-Key) is expected to help.
 */
export interface DescribedApiError {
  /** Envelope `code`, or a client code: NETWORK_ERROR, AUTH_EXPIRED. */
  code: string | null
  status: number | null
  message: string
  hint?: string
  retryable: boolean
  retryAfterMs?: number
}

interface CodeCopy {
  message: string
  hint?: string
  retryable?: boolean
  retryAfterMs?: number
}

type Details = Record<string, unknown>

interface CopyContext {
  error: ApiError
  details: Details
}

type CopyBuilder = (context: CopyContext) => CodeCopy

function asDetails(value: unknown): Details {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Details) : {}
}

function stringField(details: Details, key: string): string | null {
  const value = details[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function positiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

const RUNNER_LABELS: Record<string, string> = {
  opencode: "OpenCode",
  codex: "Codex",
  "claude-code": "Claude Code",
}

function runnerLabel(runner: string | null): string | null {
  if (!runner) return null
  return RUNNER_LABELS[runner] ?? runner
}

function supportedRunners(details: Details): string {
  const raw = details.supportedRunners
  const names = Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string").map((value) => runnerLabel(value) ?? value)
    : []
  return names.length > 0 ? names.join(", ") : "OpenCode"
}

function resourceNoun(details: Details): string {
  const type = stringField(details, "resourceType")
  return type ? type.replace(/_/g, " ") : "item"
}

/** First field-level message from a Zod `flatten()` payload, e.g. "title: Title is required". */
function firstValidationMessage(details: Details): string | null {
  const fieldErrors = asDetails(details.fieldErrors)
  for (const [field, messages] of Object.entries(fieldErrors)) {
    if (Array.isArray(messages)) {
      const first = messages.find((message): message is string => typeof message === "string" && message.length > 0)
      if (first) return `${field}: ${first}`
    }
  }
  const formErrors = details.formErrors
  if (Array.isArray(formErrors)) {
    const first = formErrors.find((message): message is string => typeof message === "string" && message.length > 0)
    if (first) return first
  }
  return null
}

function secondsToMs(value: unknown): number | undefined {
  const seconds = positiveNumber(value)
  return seconds === null ? undefined : Math.round(seconds * 1000)
}

function waitPhrase(ms: number | undefined): string {
  if (!ms) return "Wait a moment"
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `Wait ${seconds} second${seconds === 1 ? "" : "s"}`
}

const REFRESH_HINT = "Refresh the board to see the latest state."

// Home Chat copy (chat stream errors, tool results, confirmations).
const CHAT_ADMIN_HINT = "Ask an admin to check the Home Chat model settings on the server."
const CHAT_RETRY_HINT = "Retry to get a complete answer."
const CHAT_CUT_OFF_MESSAGE = "The reply was cut off before it finished."
const CHAT_FRESH_PREVIEW_HINT = "Nothing changed. Ask the assistant for a fresh preview, then confirm that one."

/** Known error codes. Exported so tests can assert the required set is covered. */
export const API_ERROR_COPY: Readonly<Record<string, CopyBuilder>> = {
  // ── Runner and execution admission (W01) ─────────────────────────────────
  INVALID_RUNNER: ({ details }) => {
    const runner = stringField(details, "runner")
    return {
      message: runner ? `The agent runner "${runner}" isn't recognized.` : "The selected agent runner isn't recognized.",
      hint: "Choose OpenCode, Claude Code or Codex as the agent for this task or its project, then run it again.",
    }
  },
  RUNNER_NOT_SUPPORTED: ({ details }) => ({
    message: `${runnerLabel(stringField(details, "runner")) ?? "This runner"} can't execute tasks yet.`,
    hint: `The execution engine currently supports ${supportedRunners(details)}. Switch the task or project agent and try again.`,
  }),
  TASK_SELECTION_CHANGED: () => ({
    message: "This task changed while execution was starting.",
    hint: `Its project, team or owner was changed. ${REFRESH_HINT}`,
  }),
  BATCH_SELECTION_CHANGED: () => ({
    message: "The selected tasks changed before the batch could start.",
    hint: "A task was edited, moved, archived or started elsewhere. Review the selection and start the batch again.",
  }),
  TASK_ARCHIVED: () => ({
    message: "Archived tasks can't be executed.",
    hint: "Restore the task from Archived, then run it again.",
  }),
  TASK_ALREADY_RUNNING: () => ({
    message: "This task is already running.",
    hint: "Wait for the current run to finish, or stop it before starting another.",
  }),
  APPROVAL_NOT_FOUND: () => ({
    message: "That approval request was already answered or has expired.",
    hint: "The list shows what is still waiting.",
  }),
  APPROVAL_CHANGED: () => ({
    message: "The operation changed since you saw it.",
    hint: "Review the updated request before deciding.",
  }),
  APPROVAL_FORBIDDEN: () => ({
    message: "Only the person who started this run can answer its approval requests.",
  }),
  // ── Project knowledge (W19b) ─────────────────────────────────────────────
  KNOWLEDGE_PEOPLE_ONLY: () => ({
    message: "Only a signed-in person can do that.",
    hint: "Agents can propose knowledge; people approve, edit or retract it.",
  }),
  KNOWLEDGE_VERSION_CONFLICT: () => ({
    message: "This entry changed since you opened it.",
    hint: "The latest revision is loaded; review it and save again.",
  }),
  KNOWLEDGE_NOT_PROPOSED: () => ({
    message: "That entry isn't waiting for approval anymore.",
  }),
  KNOWLEDGE_RETRACTED: () => ({
    message: "That entry was retracted.",
    hint: "Restore it before editing.",
  }),
  KNOWLEDGE_SEALED_SOURCE: () => ({
    message: "Knowledge can't come from a sealed (evaluation) task.",
  }),
  KNOWLEDGE_PROPOSALS_FULL: ({ error }) => ({
    message: error.message || "Too many knowledge proposals are waiting for approval.",
    hint: "Review the proposals under the project's Knowledge first.",
  }),
  APPROVAL_MODE_UNAVAILABLE: () => ({
    message: "The agent server for this checkout is still busy in another approval mode.",
    hint: "Try again when its current session has ended; nothing was started.",
    retryable: true,
  }),
  KNOWLEDGE_QUOTA_EXCEEDED: ({ error }) => ({
    message: error.message || "This project has as much knowledge as it can keep.",
    hint: "Retract entries that no longer apply, then try again.",
  }),
  // ── Agent reviews (W19a) ────────────────────────────────────────────────
  REVIEW_RUNNING: () => ({
    message: "A review of this task is already running.",
    hint: "Its findings appear in the review panel when it finishes.",
  }),
  REVIEW_RUN_ACTIVE: () => ({
    message: "The task is still running.",
    hint: "Review the change when the run has finished.",
  }),
  REVIEW_NOTHING_TO_REVIEW: () => ({
    message: "The run made no commit to review.",
  }),
  REVIEW_WORKSPACE_GONE: () => ({
    message: "The run's checkout is no longer on this device.",
    hint: "Old checkouts are cleaned up after a while. Run the task again to review it.",
  }),
  REVIEW_RUNNER_UNAVAILABLE: ({ error }) => ({
    message: error.message || "The task's agent isn't available on this device.",
    hint: "Check Settings → Agents.",
  }),
  REVIEW_UNSUPPORTED: () => ({
    message: "Agent reviews need the current run engine.",
  }),
  REVIEW_NOT_RUNNING: () => ({
    message: "That review has already finished.",
  }),
  REDIRECT_PENDING: () => ({
    message: "The agent hasn't stopped yet.",
    hint: "Its stop is still in progress; send the redirect again in a moment.",
  }),
  // ── Task dependencies (W17a) ─────────────────────────────────────────────
  TASK_BLOCKED: ({ error }) => ({
    message: error.message || "This task is blocked by unfinished tasks.",
    hint: "Finish its blockers first, run it anyway, or remove the dependency.",
  }),
  DEPENDENCY_CYCLE: ({ error }) => ({
    message: error.message || "That dependency would create a loop.",
    hint: "Tasks can't wait on each other in a circle. Remove one of the dependencies first.",
  }),
  DEPENDENCY_SCOPE: () => ({
    message: "A task can only be blocked by a task in the same project.",
  }),
  DEPENDENCY_SELF: () => ({
    message: "A task can't block itself.",
  }),
  DEPENDENCY_LIMIT: () => ({
    message: "This task already has the maximum number of blockers.",
    hint: "Remove a blocker that no longer applies, then add the new one.",
  }),
  DEPENDENCY_SCOPE_CHANGED: () => ({
    message: "One of the tasks moved while the dependency was being added.",
    hint: "Try again.",
  }),
  // ── Recurring issues (W20 / FE-14) ───────────────────────────────────────
  SCHEDULE_QUOTA_EXCEEDED: ({ details }) => {
    const limit = positiveNumber(details.limit)
    return details.kind === "total"
      ? { message: `This project already has ${limit ?? "the maximum number of"} schedules.`, hint: "Delete a schedule you no longer need, then try again." }
      : { message: `This project already has ${limit ?? "the maximum number of"} active schedules.`, hint: "Pause or delete one, then try again." }
  },
  SCHEDULE_NOT_FOUND: () => ({
    message: "This schedule no longer exists.",
    hint: "Someone may have deleted it. Issues it already created are kept.",
  }),
  // ── Outbound webhooks (FE-14) ───────────────────────────────────────────
  WEBHOOK_URL_INVALID: ({ error, details }) => {
    const reason = stringField(details, "reason")
    const hint = reason === "forbidden_address" || reason === "internal_host"
      ? "OpenLinear only delivers to public HTTPS addresses. For local testing, expose your receiver through a tunnel with a public https:// URL."
      : reason === "slack_url_required"
        ? "In Slack, add an Incoming Webhook to the channel and paste its URL, or pick another format."
        : reason === "discord_url_required"
          ? "In Discord, open the channel's Integrations → Webhooks, copy the webhook URL, or pick another format."
          : "Use a public https:// URL without a user name, password or #fragment."
    return { message: error.message || "That URL can't receive webhooks.", hint }
  },
  WEBHOOK_LIMIT_EXCEEDED: ({ details }) => {
    const limit = positiveNumber(details.limit)
    return {
      message: `This ${details.scope === "workspace" ? "workspace" : "project"} already has ${limit ?? "the maximum number of"} webhooks.`,
      hint: "Delete one you no longer use, or subscribe an existing one to more events.",
    }
  },
  WEBHOOK_ROTATION_IN_PROGRESS: () => ({
    message: "The previous secret still signs deliveries.",
    hint: "Rotate again after its 24-hour grace period ends, so receivers using it aren't cut off.",
  }),
  WEBHOOK_WORKSPACE_RESTRICTED: () => ({
    message: "This workspace webhook carries projects you can't see.",
    hint: "Ask a workspace owner who can see every project to view or change it.",
  }),
  WEBHOOK_NOT_FOUND: () => ({
    message: "This webhook no longer exists.",
    hint: "Someone may have deleted it.",
  }),
  WEBHOOK_DELIVERY_NOT_FOUND: () => ({
    message: "That delivery is no longer in the history.",
    hint: "Finished deliveries are kept for 30 days.",
  }),
  WEBHOOK_DISABLED: () => ({
    message: "This webhook is turned off.",
    hint: "Send a test ping to check the receiver, turn the webhook back on, then redeliver.",
  }),
  WEBHOOK_DELIVERY_IN_FLIGHT: () => ({
    message: "This delivery is being sent right now.",
    hint: "Wait for the result, then redeliver if it failed.",
    retryable: true,
    retryAfterMs: 5_000,
  }),
  MODEL_NOT_CONFIGURED: () => ({
    message: "No model is selected for execution.",
    hint: "Pick a model in Settings → AI Providers, then run the task again.",
  }),
  EXECUTION_STOPPED: () => ({
    message: "The run was stopped before the agent accepted the task.",
    hint: "Start it again when you're ready.",
  }),
  CANCEL_INCOMPLETE: ({ error }) => ({
    message: error.message || "The stop request couldn't be confirmed.",
    hint: "Work was retained. Retry the stop; if it keeps failing, inspect the retained branch before running again.",
  }),
  LOCAL_BATCH_NOT_SUPPORTED: () => ({
    message: "Local-folder projects can't run in a batch.",
    hint: "Run these tasks one at a time, or link the project to a GitHub repository.",
  }),
  BATCH_REPOSITORY_REQUIRED: () => ({
    message: "Every task in a batch needs a linked repository.",
    hint: "Link a GitHub repository to each task's project, then start the batch again.",
  }),
  BATCH_REPOSITORY_MISMATCH: () => ({
    message: "The selected tasks use different repositories or base branches.",
    hint: "Batch only tasks that share one repository and base branch.",
  }),
  BATCH_MODEL_MISMATCH: () => ({
    message: "Combined mode needs one model for every task.",
    hint: "Give the selected tasks the same model, or run them in Parallel or Queue mode.",
  }),
  INVALID_BATCH: () => ({
    message: "A batch needs between 1 and 20 tasks and a supported mode.",
    hint: "Adjust the selection and try again.",
  }),
  DUPLICATE_BATCH_TASK: () => ({
    message: "A task was selected twice for the same batch.",
    hint: "Clear the selection and select each task once.",
  }),
  BATCH_ALREADY_STARTED: () => ({
    message: "This batch has already started or finished.",
    hint: REFRESH_HINT,
  }),
  BATCH_NOT_READY: () => ({
    message: "The queue isn't ready for the next task yet.",
    hint: "Wait for the current task to finish, then approve the next one.",
  }),
  NO_QUEUED_TASK: () => ({
    message: "There are no queued tasks left to approve.",
    hint: REFRESH_HINT,
  }),
  BATCH_NOT_RUNNING: () => ({
    message: "This batch is no longer running.",
    hint: REFRESH_HINT,
  }),
  TASK_NOT_RUNNING: () => ({
    message: "This task has already finished.",
    hint: REFRESH_HINT,
  }),
  INVALID_EXECUTION_LIMIT: () => ({
    message: "The batch concurrency setting is invalid.",
    hint: "Set a maximum batch size between 1 and 20 in Settings → Execution.",
  }),
  NO_ACTIVE_REPO: () => ({
    message: "No repository is connected.",
    hint: "Connect a repository in Project Settings before executing tasks.",
  }),
  GITHUB_NOT_LINKED: () => ({
    message: "Your GitHub account isn't linked.",
    hint: "Link GitHub in Settings so OpenLinear can push branches and open pull requests.",
  }),

  // ── v2 run engine (W05a–W07a) ────────────────────────────────────────────
  RUN_ACTIVE: () => ({
    message: "A turn is already running for this task.",
    hint: "Wait for it to finish, or stop it first. Your drafts are kept.",
  }),
  RUN_ENGINE_STOPPED: () => ({
    message: "The execution service is shutting down.",
    hint: "Wait a few seconds for it to restart, then run the task again.",
  }),
  RUN_JOURNAL_LOCKED: () => ({
    message: "Another OpenLinear execution service is running on this machine.",
    hint: "Quit the other OpenLinear window (or the `pnpm dev` sidecar), then try again. Only one may own the run journal.",
  }),
  PARALLEL_LIMIT_REACHED: () => ({
    message: "Too many tasks are running at once.",
    hint: "Wait for a run to finish, or raise the parallel limit in Settings → Execution.",
  }),
  CLAIM_FAILED: ({ error }) => ({
    message: error.message || "The task couldn't be claimed for this run.",
    hint: `Nothing was changed. ${REFRESH_HINT}`,
  }),
  RUN_NOT_FOUND: () => ({
    message: "No run is recorded for this task on this device.",
    hint: "Runs live on the device that started them. Open the task there, or start a new run.",
  }),
  RUNTIME_NOT_REATTACHABLE: () => ({
    message: "The agent couldn't be reattached after the restart.",
    hint: "Its work was kept. Inspect the retained branch, then run the task again.",
  }),
  FOLLOW_UP_UNSUPPORTED: ({ error, details }) => ({
    message: stringField(details, "reason") === "workspace_expired"
      ? "The previous run's workspace was cleaned up, so it can't take a follow-up."
      : error.message || "This run can't take a follow-up.",
    hint: "Start a new run with your feedback in the task description instead.",
  }),
  FOLLOW_UP_RUN_MISMATCH: () => ({
    message: "This run was started on another device, or a newer run exists here.",
    hint: "Open the latest run, or start a new one. Nothing was changed.",
  }),
  AGENT_MAY_BE_RUNNING: () => ({
    message: "The interrupted agent couldn't be confirmed stopped, so its turn can't be continued.",
    hint: "Its work is kept. Start a new run instead, or try Continue again once the agent has stopped.",
  }),
  TASK_FENCE_REJECTED: () => ({
    message: "Another run took over this task, so this one stopped publishing.",
    hint: `Nothing was published from the older run. ${REFRESH_HINT}`,
  }),
  CLOUD_API_UNREACHABLE: () => ({
    message: "Can't reach OpenLinear to authorize the run.",
    hint: "Check your connection and try again. Runs need the OpenLinear API to start and to publish.",
  }),

  // ── Repository credentials (W10a) ────────────────────────────────────────
  GITHUB_APP_REQUIRED: ({ details }) => ({
    message: "This workspace requires the OpenLinear GitHub App for repository access.",
    hint: stringField(details, "installUrl")
      ? "Install the app on this repository (link in the run details), then run the task again."
      : "Ask a workspace admin to install the OpenLinear GitHub App on this repository, then run the task again.",
  }),
  GITHUB_APP_UNAVAILABLE: () => ({
    message: "GitHub didn't issue a repository credential.",
    hint: "GitHub may be down, or the app's credentials are misconfigured. Try again shortly; if it persists, tell a workspace admin.",
  }),
  GITHUB_APP_TOKEN_REJECTED: () => ({
    message: "GitHub issued a broader credential than requested, so OpenLinear refused it.",
    hint: "Nothing used it and it was revoked. Ask a workspace admin to check the app installation's repository access.",
  }),
  GIT_CREDENTIAL_UNUSABLE: ({ error }) => ({
    message: error.message || "The repository credential couldn't be used.",
    hint: "OpenLinear needs git 2.31 or newer. Update git, then run the task again.",
  }),

  // ── Verification (W11a) ──────────────────────────────────────────────────
  VERIFICATION_REQUIRED: () => ({
    message: "This project requires passing checks before a task is done.",
    hint: "Fix the failing checks (see the run's Verification), then run the task again.",
  }),
  VERIFICATION_CONFLICT: () => ({
    message: "Different check results were already recorded for this commit.",
    hint: REFRESH_HINT,
  }),
  // W16a: the project's setup steps could not run before the agent started.
  SETUP_FAILED: ({ error }) => ({
    message: error.message || "The project's setup steps failed before the agent started.",
    hint: "Fix the setup steps in the project's Verification settings, then run the task again.",
  }),

  // ── Forward-compatible codes (sandbox and sidecar persistence work) ──────
  SANDBOX_UNAVAILABLE: ({ error }) => ({
    message: error.message || "No isolated sandbox is available to run this task.",
    hint: "Execution was blocked instead of running unprotected on this machine. Check the sandbox setup in Settings, then try again.",
  }),
  // FE-03 project trust grants (Settings → Agents)
  TRUST_GRANT_NOT_NEEDED: () => ({
    message: "The sandbox is working on this device, so no trust grant is needed.",
    hint: "Runs are isolated. Grants only matter while the sandbox is unavailable.",
  }),
  TRUST_GRANT_NOT_APPLICABLE: ({ error }) => ({
    message: error.message || "Project trust grants aren't used on this device.",
  }),
  TRUST_GRANT_EXISTS: () => ({
    message: "Runs without the sandbox are already allowed for this project.",
    hint: "Revoke that grant first if you want to change its reason or duration.",
  }),
  TRUST_GRANT_LIMIT: ({ error }) => ({
    message: error.message || "Too many trust grants are active.",
    hint: "Revoke one you no longer need, then try again.",
  }),
  TRUST_GRANT_NOT_FOUND: () => ({
    message: "That trust grant no longer exists.",
    hint: "It may have been revoked already. The list shows what is still active.",
  }),
  SANDBOX_CHECK_PENDING: () => ({
    message: "The sandbox check hasn't finished yet.",
    hint: "Wait a moment and try again.",
    retryable: true,
  }),
  BATCH_REQUIRES_API_PERSISTENCE: ({ error }) => ({
    message: error.message || "Batch execution isn't available with this execution service.",
    hint: "Batches need the current run engine. Run these tasks one at a time, or switch OPENLINEAR_RUN_ENGINE back to its default (v2) and restart.",
  }),
  BATCH_MODE_UNAVAILABLE: () => ({
    message: "Combined batches aren't available yet.",
    hint: "Run the tasks in Parallel or Queue mode — each one opens its own verified pull request.",
  }),

  // ── Authorization (W02a) ─────────────────────────────────────────────────
  PAT_WORKSPACE_RESTRICTED: () => ({
    message: "This access token is limited to a different workspace.",
    hint: "Use a personal access token created for this workspace, or sign in with your account.",
  }),
  OWNERSHIP_REQUIRED: ({ error, details }) =>
    error.status === 404
      ? {
          message: `This ${resourceNoun(details)} no longer exists or you no longer have access to it.`,
          hint: REFRESH_HINT,
        }
      : {
          message: `You don't have permission to change this ${resourceNoun(details)}.`,
          hint: "Ask a project or team admin for full access.",
        },
  FORBIDDEN: ({ error }) => ({
    message: error.message || "You don't have permission to do that.",
    hint: "Ask a workspace admin for access.",
  }),
  INSUFFICIENT_SCOPE: () => ({
    message: "This personal access token doesn't allow that action.",
    hint: "Create a token with write access, or sign in with your account.",
  }),
  SESSION_REQUIRED: () => ({
    message: "This action needs a signed-in session.",
    hint: "Personal access tokens can't do this. Sign in with your account and try again.",
  }),
  AUTH_REQUIRED: () => ({
    message: "You're signed out.",
    hint: "Sign in again to continue.",
  }),

  // ── Idempotency (W04a) ───────────────────────────────────────────────────
  IDEMPOTENCY_CONFLICT: () => ({
    message: "This request was already submitted with different details.",
    hint: "Nothing new was saved. Review your changes and submit again.",
  }),
  IDEMPOTENCY_IN_PROGRESS: ({ details }) => {
    const retryAfterMs = secondsToMs(details.retryAfterSeconds) ?? 1000
    return {
      message: "Your earlier request is still being processed.",
      hint: `${waitPhrase(retryAfterMs)}; it finishes on its own and won't be saved twice.`,
      retryable: true,
      retryAfterMs,
    }
  },
  IDEMPOTENCY_KEY_INVALID: () => ({
    message: "The request couldn't be sent safely.",
    hint: "Reload the app and try again.",
  }),
  IDEMPOTENCY_RESPONSE_TOO_LARGE: () => ({
    message: "Too much to create in one request.",
    hint: "Nothing was saved. Split it into smaller batches and try again.",
  }),

  // ── Validation, lookup and rate limits ───────────────────────────────────
  VALIDATION_ERROR: ({ error, details }) => ({
    message: firstValidationMessage(details) ?? (error.message || "Some fields are invalid."),
    hint: "Check the highlighted fields and try again.",
  }),
  NOT_FOUND: ({ error }) => ({
    message: error.message || "That item no longer exists.",
    hint: REFRESH_HINT,
  }),
  TASK_NOT_FOUND: () => ({
    message: "One or more tasks no longer exist.",
    hint: REFRESH_HINT,
  }),
  P2025: () => ({
    message: "That item no longer exists.",
    hint: REFRESH_HINT,
  }),
  RATE_LIMITED: ({ details }) => {
    const retryAfterMs = secondsToMs(details.retryAfterSeconds)
    return {
      message: "Too many requests.",
      hint: `${waitPhrase(retryAfterMs)} and try again.`,
      retryAfterMs,
    }
  },

  // ── Bulk task changes and list paging (W14) ──────────────────────────────
  TASK_IDS_REQUIRED: () => ({
    message: "No tasks were selected, so nothing changed.",
    hint: "Select the tasks to change and try again.",
  }),
  BULK_SCOPE_INVALID: () => ({
    message: "These tasks couldn't be changed in one request.",
    hint: `Each bulk change must target one project or one team. ${REFRESH_HINT}`,
  }),
  INVALID_CURSOR: () => ({
    message: "The task list changed while loading more.",
    hint: REFRESH_HINT,
  }),

  // ── Home Chat: model provider and turn errors (W15/W18a) ─────────────────
  LLM_RATE_LIMITED: ({ details }) => {
    const retryAfterMs = secondsToMs(details.retryAfterSeconds)
    return {
      message: "The AI provider is rate-limiting requests.",
      hint: `${waitPhrase(retryAfterMs)}, then retry.`,
      retryable: true,
      retryAfterMs,
    }
  },
  LLM_QUOTA_EXCEEDED: () => ({
    message: "The AI provider account is out of quota or credits.",
    hint: `Retrying won't help until it's topped up. ${CHAT_ADMIN_HINT}`,
  }),
  LLM_PROVIDER_UNAVAILABLE: () => ({
    message: "The AI provider is temporarily unavailable.",
    hint: "Retry in a moment.",
    retryable: true,
  }),
  LLM_TIMEOUT: () => ({
    message: "The AI provider stopped responding.",
    hint: "Retry in a moment.",
    retryable: true,
  }),
  LLM_NETWORK_ERROR: () => ({
    message: "OpenLinear couldn't reach the AI provider.",
    hint: "Retry in a moment.",
    retryable: true,
  }),
  LLM_AUTH_FAILED: () => ({
    message: "The AI provider rejected the server's API key.",
    hint: CHAT_ADMIN_HINT,
  }),
  LLM_NOT_CONFIGURED: () => ({
    message: "Home Chat has no AI model configured on this server.",
    hint: CHAT_ADMIN_HINT,
  }),
  LLM_MISCONFIGURED: () => ({
    message: "The Home Chat model settings on this server are invalid.",
    hint: CHAT_ADMIN_HINT,
  }),
  LLM_MODEL_NOT_FOUND: () => ({
    message: "The configured chat model doesn't exist at the AI provider.",
    hint: CHAT_ADMIN_HINT,
  }),
  LLM_BAD_REQUEST: () => ({
    message: "The AI provider rejected this request.",
    hint: "Rephrase it or remove attachments, then retry.",
  }),
  LLM_REQUEST_REJECTED: () => ({
    message: "The AI provider rejected this request.",
    hint: "Rephrase it or remove attachments, then retry.",
  }),
  LLM_CONTEXT_OVERFLOW: () => ({
    message: "This conversation is too long for the model.",
    hint: "Start a new chat, or remove large attachments, and ask again.",
  }),
  LLM_STREAM_TRUNCATED: () => ({ message: CHAT_CUT_OFF_MESSAGE, hint: CHAT_RETRY_HINT, retryable: true }),
  LLM_STREAM_ERROR: () => ({ message: CHAT_CUT_OFF_MESSAGE, hint: CHAT_RETRY_HINT, retryable: true }),
  LLM_STREAM_MALFORMED: () => ({ message: CHAT_CUT_OFF_MESSAGE, hint: CHAT_RETRY_HINT, retryable: true }),
  LLM_EMPTY_STREAM: () => ({ message: "The AI provider sent an empty reply.", hint: CHAT_RETRY_HINT, retryable: true }),
  LLM_RESPONSE_MALFORMED: () => ({ message: "The AI provider sent an unreadable reply.", hint: CHAT_RETRY_HINT, retryable: true }),
  LLM_OUTPUT_TRUNCATED: () => ({
    message: "The model ran out of room while preparing an action, so nothing was run.",
    hint: "Retry, or ask for fewer changes at once.",
  }),
  CHAT_STREAM_INTERRUPTED: () => ({
    message: "The connection closed before the reply finished.",
    hint: CHAT_RETRY_HINT,
    retryable: true,
  }),
  TURN_TIMEOUT: () => ({
    message: "This reply hit the time limit for one turn.",
    hint: "Retry, or split the request into smaller steps.",
  }),
  ROUND_LIMIT: () => ({
    message: "The assistant used up its tool steps for one reply.",
    hint: "Ask it to continue, or split the request into smaller steps.",
  }),
  CLIENT_ABORTED: () => ({
    message: "The reply was stopped before it finished.",
    hint: CHAT_RETRY_HINT,
  }),
  CHAT_TURN_FAILED: () => ({
    message: "The assistant hit an error while answering.",
    hint: "Retry; if it keeps failing, start a new chat.",
    retryable: true,
  }),
  CHAT_STREAM_FAILED: () => ({
    message: "The assistant hit an error while answering.",
    hint: "Retry; if it keeps failing, start a new chat.",
    retryable: true,
  }),
  SESSION_NOT_FOUND: () => ({
    message: "This chat no longer exists, or you no longer have access to it.",
    hint: "Start a new chat.",
  }),
  PROJECT_SCOPE_MISMATCH: () => ({
    message: "That project isn't in this chat's workspace.",
    hint: "Pick a project from the same workspace.",
  }),

  // ── Home Chat: tool results and confirmations (W18a) ─────────────────────
  CONFIRMATION_REQUIRED: () => ({
    message: "This change needs your confirmation.",
    hint: "Review the preview, then confirm or dismiss it.",
  }),
  CONFIRMATION_EXPIRED: () => ({
    message: "This confirmation expired; codes are valid for 10 minutes.",
    hint: CHAT_FRESH_PREVIEW_HINT,
  }),
  CONFIRMATION_USED: () => ({
    message: "This confirmation was already used.",
    hint: "Nothing ran twice. Ask for a fresh preview to make another change.",
  }),
  CONFIRMATION_STALE: () => ({
    message: "The issues changed after this preview was made.",
    hint: CHAT_FRESH_PREVIEW_HINT,
  }),
  CONFIRMATION_INVALID: () => ({
    message: "That confirmation code doesn't belong to this change.",
    hint: CHAT_FRESH_PREVIEW_HINT,
  }),
  CONFIRMATION_NOT_FROM_USER: () => ({
    message: "Only you can confirm this change.",
    hint: "Use Confirm on the preview card, or reply with its code.",
  }),
  CONFIRMATION_REQUIRES_USER_TURN: () => ({
    message: "A confirmation has to come from your next message.",
    hint: "Use Confirm on the preview card, or reply with its code.",
  }),
  TOOL_OUTCOME_UNKNOWN: () => ({
    message: "This action was interrupted, so it may or may not have been applied.",
    hint: "Check the affected issues before trying it again.",
  }),
  TOOL_TIMEOUT: () => ({
    message: "This action took too long and was stopped.",
    hint: CHAT_RETRY_HINT,
  }),
  TOOL_CALL_IN_PROGRESS: () => ({
    message: "This action is already running.",
    hint: "Wait for it to finish.",
  }),
  SELECTION_TOO_LARGE: ({ details }) => {
    const limit = positiveNumber(details.limit) ?? 100
    return {
      message: `Too many issues for one bulk change (limit ${limit}).`,
      hint: "Ask for a smaller, explicit set of issues.",
    }
  },
  EXPLICIT_IDS_REQUIRED: () => ({
    message: "Archiving needs an explicit list of issues.",
    hint: "Name the issues to archive.",
  }),
  INVALID_TOOL_ARGUMENTS: () => ({
    message: "The assistant prepared a malformed action, so nothing was run.",
    hint: CHAT_RETRY_HINT,
  }),
  TOOL_REQUIRES_APPROVAL: () => ({
    message: "The assistant can't change access or roles.",
    hint: "Make this change yourself in workspace or project settings.",
  }),
  UNKNOWN_TOOL: () => ({
    message: "The assistant tried an action that doesn't exist.",
    hint: CHAT_RETRY_HINT,
  }),
}

function describeByStatus(error: ApiError): CodeCopy {
  const server = error.message
  if (error.status === 403) return { message: server || "You don't have permission to do that." }
  if (error.status === 404) return { message: server || "That item no longer exists.", hint: REFRESH_HINT }
  if (error.status === 429) return { message: server || "Too many requests.", hint: "Wait a moment and try again." }
  if (error.status >= 500) {
    return {
      message: server || "The server hit an error.",
      hint: "Try again shortly.",
      retryable: error.status === 502 || error.status === 503 || error.status === 504,
    }
  }
  return { message: server || `Request failed (${error.status}).` }
}

export function describeApiError(error: unknown, fallbackMessage = "Something went wrong."): DescribedApiError {
  if (error instanceof AuthExpiredError) {
    return {
      code: "AUTH_EXPIRED",
      status: 401,
      message: "Your session expired.",
      hint: "Sign in again to continue.",
      retryable: false,
    }
  }
  if (error instanceof ApiError) {
    const builder = error.code ? API_ERROR_COPY[error.code] : undefined
    const copy = builder ? builder({ error, details: asDetails(error.details) }) : describeByStatus(error)
    return {
      code: error.code ?? null,
      status: error.status,
      message: copy.message || fallbackMessage,
      ...(copy.hint ? { hint: copy.hint } : {}),
      retryable: copy.retryable ?? false,
      ...(copy.retryAfterMs !== undefined ? { retryAfterMs: copy.retryAfterMs } : {}),
    }
  }
  if (error instanceof NetworkError) {
    return {
      code: "NETWORK_ERROR",
      status: null,
      message: "Couldn't reach OpenLinear.",
      hint: "Check your connection and try again.",
      retryable: true,
      retryAfterMs: error.retryAfterMs,
    }
  }
  if (error instanceof Error && error.message) {
    return { code: null, status: null, message: error.message, retryable: false }
  }
  return { code: null, status: null, message: fallbackMessage, retryable: false }
}

export function getApiErrorCode(error: unknown): string | null {
  return error instanceof ApiError ? error.code ?? null : null
}

export function isApiErrorCode(error: unknown, ...codes: string[]): boolean {
  const code = getApiErrorCode(error)
  return code !== null && codes.includes(code)
}

/** Single-line form for inline errors (form roots, panels). */
export function formatApiError(error: unknown, fallbackMessage?: string): string {
  const described = describeApiError(error, fallbackMessage)
  return described.hint ? `${described.message} ${described.hint}` : described.message
}

export interface ApiErrorToastOptions {
  /** Headline override; the mapped message then moves into the description. */
  title?: string
  fallbackMessage?: string
  action?: { label: string; onClick: () => void }
}

/** Show an error toast with the mapped message and hint. Returns the description used. */
export function toastApiError(error: unknown, options: ApiErrorToastOptions = {}): DescribedApiError {
  const described = describeApiError(error, options.fallbackMessage)
  const detail = described.hint ? `${described.message} ${described.hint}` : described.message
  const title = options.title ?? described.message
  const description = options.title ? detail : described.hint
  toast.error(title, {
    ...(description ? { description } : {}),
    ...(options.action ? { action: options.action } : {}),
  })
  return described
}
