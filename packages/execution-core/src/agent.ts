export type RunnerId = 'opencode' | 'claude-code' | 'codex';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface CostBreakdown {
  usd: number;
  basis?: string;
}

export interface ModelRef {
  provider?: string;
  id: string;
}

export interface RunnerCapabilities {
  streamingDeltas: boolean;
  reasoningDeltas: boolean;
  permissionReply: boolean;
  interrupt: boolean;
  compact: boolean;
  revert: boolean;
  fork: boolean;
  cacheSplitUsage: boolean;
}

export interface PermissionPolicy {
  default: 'allow' | 'deny' | 'ask';
}

export interface SandboxHandle {
  cwd: string;
  env: Record<string, string>;
  pgid?: number;
}

export interface StartInput {
  runId: string;
  worktreePath: string;
  systemContract: string;
  prompt: string;
  model?: ModelRef;
  budgets: {
    maxTurns?: number;
    maxTokens?: number;
    maxUsd?: number;
    wallClockMs: number;
  };
  permissions: PermissionPolicy;
  sandbox: SandboxHandle;
  env: Record<string, string>;
  signal: AbortSignal;
}

export interface ResumeInput {
  worktreePath: string;
  signal: AbortSignal;
  /**
   * W07 (additive, optional): continuation input for the resumed session.
   * When omitted, runners send their documented continuation instruction
   * instead of replaying the original task.
   */
  prompt?: string;
  /** Model to continue with; runners that persist the session model may ignore it. */
  model?: ModelRef;
  /** Explicit per-run provider credentials (same contract as `StartInput.env`). */
  env?: Record<string, string>;
  permissions?: PermissionPolicy;
}

export type AgentEvent =
  | { t: 'session.started'; externalId: string; model: ModelRef }
  | { t: 'turn.started'; turn: number }
  | { t: 'message.delta'; text: string }
  | { t: 'reasoning.delta'; text: string }
  | { t: 'tool.started'; callId: string; name: string; input: unknown }
  | { t: 'tool.output'; callId: string; chunk: string; cumulative?: boolean }
  | { t: 'tool.finished'; callId: string; name: string; ok: boolean; summary?: string }
  | { t: 'file.changed'; path: string; kind: 'edit' | 'create' | 'delete' }
  | { t: 'permission.requested'; id: string; tool: string; detail: string }
  | { t: 'compaction'; phase: 'start' | 'end'; before?: number; after?: number }
  | { t: 'usage'; usage: TokenUsage; cost?: CostBreakdown; messageId?: string }
  | { t: 'turn.finished'; turn: number; reason: 'idle' | 'max_turns' | 'error' | 'interrupted' }
  | { t: 'heartbeat' }
  | { t: 'error'; code: string; message: string; retryable: boolean; retryAfterMs?: number }
  /**
   * W07 (additive): a non-fatal observation about the provider stream — a
   * malformed or unknown line that was tolerated, a provider retry, a denied
   * tool call. Never terminal; consumers may ignore it (the journal keeps it).
   */
  | { t: 'diagnostic'; code: string; message: string; detail?: string }
  /**
   * W07 (additive): positive confirmation that a cancellation took effect,
   * emitted once, immediately before `turn.finished` with reason
   * `interrupted`. `confirmedBy` says what proved it: the agent runtime
   * acknowledged the interrupt (`runner-ack`), its server acknowledged the
   * abort (`server-ack`), the process was observed to exit (`process-exit`),
   * or nothing had been started yet (`not-started`).
   */
  | {
      t: 'cancel.receipt';
      via: 'interrupt' | 'abort' | 'signal';
      confirmedBy: 'runner-ack' | 'server-ack' | 'process-exit' | 'not-started';
      exitCode?: number | null;
      exitSignal?: string | null;
    };

export interface AgentSession {
  readonly externalId: string;
  readonly events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  abort(): Promise<void>;
  replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void>;
  /**
   * FE-04 (optional): the runner withdrew a permission request it had asked
   * (it no longer needs an answer). Returns an unsubscribe function.
   */
  onPermissionWithdrawn?(listener: (id: string) => void): () => void;
  contextUsage?(): Promise<{ used: number; limit: number }>;
  compact?(): Promise<void>;
}

export interface ModelDescriptor {
  id: string;
  provider: string;
  name?: string;
}

/** W07 (additive): authentication readiness reported without any inference. */
export interface RunnerAuthStatus {
  /**
   * `ok`: a credential the runtime will use is present and reachable in the
   * current sandbox mode. `missing`: not logged in. `unreachable-in-sandbox`:
   * logged in, but the login lives where the agent sandbox deliberately does
   * not reach (an explicit credential or a trusted-host grant is required).
   * `unknown`: the runtime has no non-inference status command.
   */
  status: 'ok' | 'missing' | 'unreachable-in-sandbox' | 'unknown';
  /** Non-secret method label, e.g. `claude.ai`, `chatgpt`, `api-key`. */
  method?: string;
  detail?: string;
}

/** Result of `AgentRunner.healthCheck()`. Extra fields are optional (W07). */
export interface RunnerHealth {
  ok: boolean;
  detail?: string;
  version?: string;
  auth?: RunnerAuthStatus;
  /** Absolute path of the runtime binary that would be launched. */
  binary?: string;
}

/**
 * W07 (additive): what a runner can actually do, for a runner picker and for
 * routing decisions. Values describe this adapter, not the vendor's product.
 */
export interface RunnerFeatures {
  /** Whether a saved native session can be continued by id. */
  resume: 'native-session' | 'none';
  /**
   * `graceful-ack`: the runtime acknowledges an in-band interrupt and ends the
   * turn; `server-abort`: an abort request to the runtime's server;
   * `process-abort`: the process group is signalled (no graceful turn end).
   */
  interrupt: 'graceful-ack' | 'server-abort' | 'process-abort';
  /** `interactive`: `permission.requested` + `replyPermission`; `policy-only`: decided by the start policy. */
  approvals: 'interactive' | 'policy-only';
  models: {
    /** `live`: `listModels()` queries the runtime; `none`: it returns []. */
    discovery: 'live' | 'none';
    /** Documented aliases the runtime resolves itself. */
    aliases: string[];
    /** Whether an arbitrary model id is passed through to the runtime. */
    passthrough: boolean;
  };
  /** Known context window in tokens, or null when it is model/account dependent. */
  maxContextTokens: number | null;
  usage: {
    cost: 'reported' | 'none';
    cacheSplit: boolean;
    reasoning: boolean;
    /** See `reduceUsage`. */
    semantics: 'snapshot-per-message' | 'delta-per-turn';
  };
  /** How the runtime process is isolated (W09a). */
  isolation: 'sandbox-provider-process' | 'sandbox-provider-server';
  /** Lowest runtime version this adapter supports, when it checks one. */
  minVersion?: string;
}

export interface AgentRunner {
  readonly id: RunnerId;
  readonly capabilities: RunnerCapabilities;
  /** W07 (additive, optional): richer capability description for pickers. */
  readonly features?: RunnerFeatures;
  healthCheck(): Promise<RunnerHealth>;
  listModels(): Promise<ModelDescriptor[]>;
  start(input: StartInput): Promise<AgentSession>;
  resume(externalSessionId: string, input: ResumeInput): Promise<AgentSession>;
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/**
 * W07 (additive): the one accounting rule for `usage` events across runners.
 *
 * - A `usage` event WITH `messageId` is a cumulative snapshot for that
 *   message: a later event with the same id replaces the earlier one.
 * - A `usage` event WITHOUT `messageId` is a delta and is added.
 *
 * Category meaning stays provider-raw (W00): OpenAI-family runners report
 * `cacheRead` as a subset of `input` and `reasoning` as a subset of `output`;
 * Anthropic-family runners report `input`, `cacheRead` and `cacheWrite` as
 * disjoint, with `reasoning` a subset of `output`. Never add subsets together.
 */
export function reduceUsage(events: Iterable<AgentEvent>): { usage: TokenUsage; costUsd: number } {
  const snapshots = new Map<string, { usage: TokenUsage; costUsd: number }>();
  let usage = emptyTokenUsage();
  let costUsd = 0;
  for (const event of events) {
    if (event.t !== 'usage') continue;
    const entry = { usage: event.usage, costUsd: event.cost?.usd ?? 0 };
    if (event.messageId) {
      snapshots.set(event.messageId, entry);
    } else {
      usage = addTokenUsage(usage, entry.usage);
      costUsd += entry.costUsd;
    }
  }
  for (const entry of snapshots.values()) {
    usage = addTokenUsage(usage, entry.usage);
    costUsd += entry.costUsd;
  }
  return { usage, costUsd };
}

export function executionSseId(runId: string, seq: number): string {
  return `run:${runId}:${seq}`;
}

export function parseExecutionSseId(raw: string): { runId: string; seq: number } | null {
  const match = /^run:([^:]+):(\d+)$/.exec(raw.trim());
  if (!match) return null;
  const runId = match[1];
  const seq = Number(match[2]);
  if (!runId || !Number.isFinite(seq)) return null;
  return { runId, seq };
}
