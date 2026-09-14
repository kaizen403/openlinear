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
  | { t: 'error'; code: string; message: string; retryable: boolean; retryAfterMs?: number };

export interface AgentSession {
  readonly externalId: string;
  readonly events: AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  abort(): Promise<void>;
  replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void>;
  contextUsage?(): Promise<{ used: number; limit: number }>;
  compact?(): Promise<void>;
}

export interface ModelDescriptor {
  id: string;
  provider: string;
  name?: string;
}

export interface AgentRunner {
  readonly id: RunnerId;
  readonly capabilities: RunnerCapabilities;
  healthCheck(): Promise<{ ok: boolean; detail?: string; version?: string }>;
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
