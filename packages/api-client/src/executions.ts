import { type HttpTransport, normalizeBaseUrl, type RequestOptions, sendJson } from "./http";

/**
 * W03a execution control contract. The server is authoritative; see
 * apps/api/src/schemas/executions.ts and apps/api/src/routes/executions.ts.
 */

export interface ExecutionRepository {
  id: string;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
}

export interface ExecutionTaskSnapshot {
  id: string;
  title: string;
  description: string | null;
  model: string | null;
  agent: string | null;
  teamId: string | null;
  creatorId: string | null;
  workspaceId: string | null;
  projectId: string | null;
  project: {
    id: string;
    localPath: string | null;
    defaultAgent: string | null;
    workspaceId?: string | null;
    repository: ExecutionRepository | null;
  } | null;
  labels: Array<{ taskId: string; labelId: string; label: { id: string; name: string; color: string } }>;
}

export interface ExecutionAuthority {
  id: string;
  projectId: string | null;
  teamId: string | null;
  creatorId: string | null;
  archived: boolean;
  status: string;
}

export interface ExecutionSettings {
  parallelLimit: number;
  maxBatchSize: number;
  queueAutoApprove: boolean;
  stopOnFailure: boolean;
  conflictBehavior: "skip" | "fail";
  /** W15a (additive): per-run budgets; null/absent = no limit. */
  maxRunCostUsd?: number | null;
  maxRunTokens?: number | null;
  /** FE-04 (additive): "ask" = permission requests wait for the user. */
  approvalMode?: "auto" | "ask";
}

export interface ExecutionSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  task: ExecutionTaskSnapshot;
  authority: ExecutionAuthority;
  settings: ExecutionSettings;
  /**
   * W11a (additive): the project's verification settings
   * (`executionSettings.verification`), captured at attempt start so the
   * checks the run is graded with are fixed before the agent runs. Absent
   * from older control planes; null when the project configures none.
   */
  verification?: unknown;
  /**
   * W19b (additive): the project's active knowledge at start (written or
   * approved by people), bounded. Absent from older control planes.
   */
  knowledge?: Array<{ id: string; version: number; kind: "note" | "convention" | "procedure"; title: string; body: string }>;
}

/** W11a: one check's evidence as recorded with the control plane (no local paths). */
export interface ExecutionVerificationCheck {
  id: string;
  name: string;
  required: boolean;
  status: "passed" | "failed" | "timed_out" | "error" | "skipped";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  network: "none" | "egress";
  command: string;
  logSha256: string | null;
  logBytes: number;
  logTruncated: boolean;
  logTail: string;
  detail: string | null;
}

/** W11a: verification evidence bound to (attempt, commit, checks hash, environment, runner). */
export interface ExecutionVerificationInput {
  runId: string;
  commitSha: string;
  baseSha: string | null;
  checksHash: string;
  policy: "require-pass" | "warn" | "off";
  status: "passed" | "failed" | "error" | "skipped";
  publication: "allowed" | "blocked";
  source: "project" | "repository" | "auto-detect" | "none";
  runner: string;
  environment: {
    sandboxMode: "enforce" | "trusted-host" | "none";
    provider: string | null;
    providerVersion: string | null;
    policyHashes: string[];
    platform: string;
    arch: string;
    checkout: "pristine-clone";
  };
  checks: ExecutionVerificationCheck[];
  warnings: string[];
  detail: string | null;
  startedAt: string;
  finishedAt: string;
}

export interface ExecutionVerificationRecord {
  id: string;
  attemptId: string;
  repeated: boolean;
}

export interface StartedExecutionAttempt {
  attempt: { id: string; taskId: string; status: string; createdAt: string };
  capability: { token: string; expiresAt: string; scopes: string[] };
  snapshot: ExecutionSnapshot;
}

export interface ExecutionPrincipal {
  userId: string;
  username: string | null;
  authSource: "session" | "pat";
  scopes: string[];
  workspaceId: string | null;
}

export interface ExecutionTaskAccess {
  taskId: string;
  permission: "full" | "view";
  canWrite: boolean;
  authority: ExecutionAuthority;
}

export interface ExecutionLogEntry {
  timestamp: string;
  type: "info" | "agent" | "tool" | "error" | "success";
  message: string;
  details?: string;
}

export type ExecutionProgressPayload = {
  status: string;
  message: string;
} & Record<string, string | number | boolean | null>;

export type ExecutionEvent =
  | { seq: number; type: "execution:progress"; payload: ExecutionProgressPayload }
  | { seq: number; type: "execution:log"; payload: { entry: ExecutionLogEntry } };

/** A task row as broadcast in `task:updated` (labels flattened). */
export type ExecutionTaskProjection = Record<string, unknown> & { id: string };

export interface ClaimedExecutionAttempt {
  attemptId: string;
  status: string;
  agentRunId: string;
  task: ExecutionTaskProjection | null;
}

export interface ExecutionEventsResult {
  accepted: number;
  duplicates: number;
  lastSeq: number;
  cancelRequested: boolean;
}

export interface ExecutionHeartbeat {
  attemptId: string;
  status: string;
  cancelRequested: boolean;
  heartbeatAt: string;
  capabilityExpiresAt: string;
}

export interface ExecutionTerminalInput {
  status: "done" | "cancelled";
  executionElapsedMs?: number;
  executionProgress?: number | null;
  executionPausedAt?: string | null;
  prUrl?: string | null;
  outcome?: string | null;
}

export interface ExecutionTerminalResult {
  attemptId: string;
  status: string;
  terminalStatus: "done" | "cancelled" | null;
  repeated: boolean;
  task: ExecutionTaskProjection | null;
}

export interface ExecutionRunUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costBasis?: string;
}

export interface ExecutionRunInput {
  status: "succeeded" | "failed" | "cancelled";
  usage?: ExecutionRunUsage;
  prUrl?: string | null;
  errorMessage?: string | null;
}

/**
 * W10a: the git network effect a credential is requested for. The control
 * plane issues the narrowest credential per effect: `fetch` (clone/fetch,
 * contents:read), `push` (contents:write), `pull_request` (PR API).
 */
export type ExecutionGitCredentialEffect = "fetch" | "push" | "pull_request";

/** Which credential the control plane issued (never the value in logs). */
export type ExecutionGitCredentialKind = "installation" | "user_oauth" | "none";

export interface ExecutionGitCredential {
  provider: "github";
  /** `installation`: repo-scoped GitHub App token; `user_oauth`: the policy-allowed fallback; `none`: no token. */
  kind: ExecutionGitCredentialKind;
  effect: ExecutionGitCredentialEffect;
  token: string | null;
  repository: string | null;
  permissions: Record<string, "read" | "write"> | null;
  /** Token expiry (installation tokens, at most one hour); null for OAuth tokens. */
  expiresAt: string | null;
  /** Do not use the credential after this instant. */
  notAfter: string;
  grantId: string;
  reused: boolean;
  fallbackReason: string | null;
}

/** A rotated attempt capability (W05a renewal). The previous one stays valid for a short grace window. */
export interface ExecutionCapabilityRenewal {
  attemptId: string;
  capability: { token: string; expiresAt: string; scopes: string[] };
  previousExpiresAt: string;
  renewals: number;
}

export interface ExecutionCloseResult {
  attemptId: string;
  status: string;
  terminalStatus: string | null;
  closeReason: string | null;
}

export interface ExecutionAttemptClientOptions {
  baseUrl: string;
  attemptId: string;
  /** The run-scoped capability. Never a user credential. */
  capability: string;
  fetch?: typeof fetch;
  /** Default per-request deadline (ms). */
  timeoutMs?: number;
}

/**
 * Client bound to one attempt's capability. It can reach only that attempt's
 * callbacks; it never carries the user's token.
 */
export class ExecutionAttemptClient {
  readonly attemptId: string;
  private readonly transport: HttpTransport;
  private readonly capability: string;

  constructor(options: ExecutionAttemptClientOptions) {
    this.attemptId = options.attemptId;
    this.capability = options.capability;
    this.transport = {
      baseUrl: normalizeBaseUrl(options.baseUrl),
      fetchImpl: options.fetch ?? fetch,
      defaultTimeoutMs: options.timeoutMs,
    };
  }

  private post<T>(action: string, body: unknown, options?: RequestOptions): Promise<T> {
    return sendJson<T>(
      this.transport,
      this.capability,
      "POST",
      `/api/executions/attempts/${encodeURIComponent(this.attemptId)}/${action}`,
      body,
      options,
    );
  }

  claim(input: { sessionId: string; runner: string; model: string }, options?: RequestOptions) {
    return this.post<ClaimedExecutionAttempt>("claim", input, options);
  }

  sendEvents(events: ExecutionEvent[], options?: RequestOptions) {
    return this.post<ExecutionEventsResult>("events", { events }, options);
  }

  heartbeat(options?: RequestOptions) {
    return this.post<ExecutionHeartbeat>("heartbeat", {}, options);
  }

  persistLogs(logs: ExecutionLogEntry[], options?: RequestOptions) {
    return this.post<{ persisted: boolean }>("logs", { logs }, options);
  }

  writeTerminal(input: ExecutionTerminalInput, options?: RequestOptions) {
    return this.post<ExecutionTerminalResult>("terminal", input, options);
  }

  finalizeRun(input: ExecutionRunInput, options?: RequestOptions) {
    return this.post<{ agentRunId: string; finalized: boolean }>("run", input, options);
  }

  acknowledgeCancellation(options?: RequestOptions) {
    return this.post<{ attemptId: string; cancelRequestedAt: string | null; cancelAcknowledgedAt: string }>(
      "cancellation",
      { stopConfirmed: true },
      options,
    );
  }

  /** W10a: request the credential for one git effect right before the network operation. */
  gitCredential(effect: ExecutionGitCredentialEffect, options?: RequestOptions) {
    return this.post<ExecutionGitCredential>("git-credential", { effect }, options);
  }

  /** Rotate the capability before it expires (long runs). Requires a fresh lease. */
  renew(options?: RequestOptions) {
    return this.post<ExecutionCapabilityRenewal>("renew", {}, options);
  }

  /** W11a: record verification evidence (idempotent per attempt + commit + checks hash). */
  recordVerification(input: ExecutionVerificationInput, options?: RequestOptions) {
    return this.post<ExecutionVerificationRecord>("verification", input, options);
  }

  close(reason?: string, options?: RequestOptions) {
    return this.post<ExecutionCloseResult>("close", reason ? { reason } : {}, options);
  }
}
