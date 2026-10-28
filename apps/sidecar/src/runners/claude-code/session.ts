import { isAbsolute, relative } from 'node:path';
import type { AgentEvent, ModelRef, PermissionPolicy, TokenUsage } from '@openlinear/execution-core';
import { addTokenUsage, emptyTokenUsage } from '@openlinear/execution-core';
import { isRecord, numberField, stringField } from '../shared/jsonl';
import type { ExitInfo } from '../shared/process-group';
import { type CancelVia, ProcessAgentSession, scrubSecrets } from '../shared/process-session';
import { readSessionUsage, writeSessionUsage, type SessionUsageRecord } from '../shared/records';
import type { RunnerProcess } from '../shared/sandboxed-process';

/**
 * Decoder and lifecycle for `claude -p --input-format stream-json
 * --output-format stream-json --verbose --include-partial-messages`.
 *
 * Message shapes follow the Agent SDK's published typings
 * (`@anthropic-ai/claude-agent-sdk` 0.3.310 `sdk.d.ts`, which bundles Claude
 * Code 2.1.310): SDKSystemMessage (init, compact_boundary, status,
 * api_retry, permission_denied), SDKPartialAssistantMessage (stream_event),
 * SDKAssistantMessage, SDKUserMessage, SDKResultMessage, SDKToolProgressMessage,
 * SDKRateLimitEvent, SDKAuthStatusMessage, keep_alive, and the control
 * protocol (control_request / control_response / control_cancel_request).
 */

const TOP_LEVEL_TYPES = new Set([
  'system', 'stream_event', 'assistant', 'user', 'result', 'tool_progress', 'keep_alive',
  'rate_limit_event', 'auth_status', 'control_request', 'control_response', 'control_cancel_request',
  // Known, deliberately ignored.
  'tool_use_summary', 'prompt_suggestion',
]);

/** `system` subtypes that carry nothing the run needs. */
const QUIET_SYSTEM_SUBTYPES = new Set([
  'hook_started', 'hook_progress', 'hook_response', 'plugin_install', 'informational',
  'task_started', 'task_progress', 'task_notification', 'task_updated', 'background_tasks_changed',
  'session_state_changed', 'worker_shutting_down', 'commands_changed', 'notification',
  'files_persisted', 'memory_recall', 'elicitation_complete', 'conversation_reset', 'mirror_error',
  'local_command_output', 'thinking_tokens',
]);

const FILE_TOOLS: Readonly<Record<string, string>> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

const SUMMARY_LIMIT = 8 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;
const INTERRUPT_ACK_MS = 5_000;

/** FE-04: how much of a permission request's input is shown (and digested). */
const PERMISSION_DETAIL_LIMIT = 64_000;

function clip(text: string, limit = SUMMARY_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text;
}

/** Anthropic usage object → OpenLinear categories (input/cache are disjoint). */
export function usageFromApi(usage: Record<string, unknown>): TokenUsage {
  return {
    input: numberField(usage, 'input_tokens') ?? 0,
    output: numberField(usage, 'output_tokens') ?? 0,
    cacheRead: numberField(usage, 'cache_read_input_tokens') ?? 0,
    cacheWrite: numberField(usage, 'cache_creation_input_tokens') ?? 0,
    reasoning: 0,
  };
}

/** `result.modelUsage` (includes subagents and internal calls) summed across models. */
export function usageFromModelUsage(modelUsage: unknown): TokenUsage | null {
  if (!isRecord(modelUsage)) return null;
  let total = emptyTokenUsage();
  let any = false;
  for (const entry of Object.values(modelUsage)) {
    if (!isRecord(entry)) continue;
    any = true;
    total = addTokenUsage(total, {
      input: numberField(entry, 'inputTokens') ?? 0,
      output: numberField(entry, 'outputTokens') ?? 0,
      cacheRead: numberField(entry, 'cacheReadInputTokens') ?? 0,
      cacheWrite: numberField(entry, 'cacheCreationInputTokens') ?? 0,
      reasoning: numberField(entry, 'thinkingTokens') ?? 0,
    });
  }
  return any ? total : null;
}

function tokenTotal(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function subtractUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
  };
}

export interface ResultClassification {
  code: string;
  retryable: boolean;
}

/** Maps a failed result to a stable error code and retryability. */
export function classifyClaudeFailure(input: {
  subtype?: string;
  terminalReason?: string;
  apiErrorStatus?: number;
  assistantError?: string;
}): ResultClassification {
  const status = input.apiErrorStatus;
  const error = input.assistantError;
  if (status === 429 || error === 'rate_limit') return { code: 'rate_limit', retryable: true };
  if (status === 529 || error === 'overloaded') return { code: 'overloaded', retryable: true };
  if ((status !== undefined && status >= 500) || error === 'server_error') return { code: 'server_error', retryable: true };
  if (status === 401 || status === 403 || error === 'authentication_failed' || error === 'oauth_org_not_allowed' || error === 'account_on_hold') {
    return { code: 'auth', retryable: false };
  }
  if (error === 'billing_error') return { code: 'billing', retryable: false };
  if (input.terminalReason === 'prompt_too_long') return { code: 'context_overflow', retryable: false };
  if (input.subtype === 'error_max_budget_usd' || input.terminalReason === 'budget_exhausted') return { code: 'budget_exhausted', retryable: false };
  if (error === 'model_not_found') return { code: 'model_not_found', retryable: false };
  return { code: 'claude_code', retryable: false };
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : isRecord(part) ? `[${String(part.type)}]` : ''))
    .filter(Boolean)
    .join('\n');
}

interface PendingControl {
  resolve(response: Record<string, unknown> | null): void;
}

interface PendingPermission {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
}

export interface ClaudeSessionOptions {
  sessionId: string;
  resumed: boolean;
  model?: ModelRef;
  worktree: string;
  permissions: PermissionPolicy;
  signal: AbortSignal;
  env: NodeJS.ProcessEnv;
  killGraceMs?: number;
  interruptAckMs?: number;
}

export class ClaudeCodeSession extends ProcessAgentSession {
  private sessionId: string;
  private model: ModelRef;
  private initSeen = false;
  private readonly capabilities = new Set<string>();
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private readonly finishedTools = new Set<string>();
  private readonly streamedMessages = new Set<string>();
  private readonly emittedBlocks = new Set<string>();
  private readonly messageUsage = new Map<string, TokenUsage>();
  private readonly pendingControl = new Map<string, PendingControl>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly withdrawnListeners = new Set<(id: string) => void>();
  private readonly reportedTypes = new Set<string>();
  private currentStreamMessage: string | null = null;
  private lastAssistantError: string | undefined;
  private lastHeartbeat = 0;
  private controlCounter = 0;
  private interruptAcked = false;
  private readonly baseline: SessionUsageRecord | null;

  constructor(private readonly options: ClaudeSessionOptions) {
    super({ signal: options.signal, killGraceMs: options.killGraceMs });
    this.sessionId = options.sessionId;
    this.model = options.model ?? { provider: 'anthropic', id: 'default' };
    this.baseline = options.resumed ? readSessionUsage('claude-code', options.sessionId, options.env) : null;
  }

  get externalId(): string {
    return this.sessionId;
  }

  /** Protocol capabilities the CLI advertised in system/init. */
  get runtimeCapabilities(): string[] {
    return [...this.capabilities];
  }

  get sandbox() {
    return this.proc?.metadata ?? null;
  }

  /**
   * W07a: the process is attached now; the prompt (one stream-json user
   * message) is written when the event stream is first consumed, so nothing
   * is submitted before the consumer is ready to journal it.
   */
  begin(proc: RunnerProcess, prompt: string): void {
    this.attach(proc);
    this.deferUntilConsumed(() => {
      this.writeLine({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: prompt }] },
        parent_tool_use_id: null,
      });
    });
  }

  notStarted(): void {
    this.finishNotStarted('signal');
  }

  protected eofFailure(exit: ExitInfo): { code: string; message: string } {
    return {
      code: 'eof',
      message: `Claude Code exited before reporting a result (${exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code ?? 'unknown'}`})`,
    };
  }

  protected onMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== 'string') {
      this.reportLine('unknown_event', 'Ignored a Claude Code line without a message type');
      return;
    }
    const type = value.type;
    if (!TOP_LEVEL_TYPES.has(type)) {
      this.reportOnce(`type:${type}`, `Ignored unknown Claude Code message type ${type}`);
      return;
    }
    switch (type) {
      case 'system':
        this.onSystem(value);
        return;
      case 'stream_event':
        this.onStreamEvent(value);
        return;
      case 'assistant':
        this.onAssistant(value);
        return;
      case 'user':
        this.onUser(value);
        return;
      case 'result':
        this.onResult(value);
        return;
      case 'tool_progress':
      case 'keep_alive':
        this.heartbeat();
        return;
      case 'rate_limit_event': {
        const info = isRecord(value.rate_limit_info) ? value.rate_limit_info : {};
        if (info.status === 'rejected') {
          const resetsAt = numberField(info, 'resetsAt');
          this.emit({ t: 'diagnostic', code: 'rate_limited', message: 'Claude usage limit reached', ...(resetsAt ? { detail: `resets at ${new Date(resetsAt * 1000).toISOString()}` } : {}) });
        }
        return;
      }
      case 'auth_status': {
        const error = stringField(value, 'error');
        if (error) this.emit({ t: 'diagnostic', code: 'auth_status', message: scrubSecrets(clip(error, 500)) });
        return;
      }
      case 'control_response':
        this.onControlResponse(value);
        return;
      case 'control_request':
        this.onControlRequest(value);
        return;
      case 'control_cancel_request': {
        const requestId = stringField(value, 'request_id');
        if (requestId && this.pendingPermissions.delete(requestId)) {
          this.emit({ t: 'diagnostic', code: 'permission_withdrawn', message: `Claude Code withdrew permission request ${requestId}` });
          for (const listener of [...this.withdrawnListeners]) {
            try {
              listener(requestId);
            } catch {
              // A listener must not break the stream.
            }
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private reportOnce(key: string, message: string): void {
    if (this.reportedTypes.has(key)) return;
    this.reportedTypes.add(key);
    this.emit({ t: 'diagnostic', code: 'unknown_event', message });
  }

  private heartbeat(): void {
    const now = Date.now();
    if (now - this.lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    this.lastHeartbeat = now;
    this.emit({ t: 'heartbeat' });
  }

  private onSystem(message: Record<string, unknown>): void {
    const subtype = stringField(message, 'subtype') ?? '';
    switch (subtype) {
      case 'init': {
        const sessionId = stringField(message, 'session_id');
        if (sessionId) this.sessionId = sessionId;
        const model = stringField(message, 'model');
        if (model) this.model = { provider: 'anthropic', id: model };
        if (Array.isArray(message.capabilities)) {
          for (const capability of message.capabilities) if (typeof capability === 'string') this.capabilities.add(capability);
        }
        if (!this.initSeen) {
          this.initSeen = true;
          this.turn = 1;
          this.emit({ t: 'session.started', externalId: this.sessionId, model: this.model });
          this.emit({ t: 'turn.started', turn: 1 });
        }
        return;
      }
      case 'status':
        if (message.status === 'compacting') this.emit({ t: 'compaction', phase: 'start' });
        return;
      case 'compact_boundary': {
        const meta = isRecord(message.compact_metadata) ? message.compact_metadata : {};
        const before = numberField(meta, 'pre_tokens');
        this.emit({ t: 'compaction', phase: 'end', ...(before !== undefined ? { before } : {}) });
        return;
      }
      case 'api_retry': {
        const status = numberField(message, 'error_status');
        const delay = numberField(message, 'retry_delay_ms');
        this.emit({
          t: 'diagnostic',
          code: 'api_retry',
          message: `Claude API ${stringField(message, 'error') ?? 'error'} (${status ?? 'no response'}); retry ${numberField(message, 'attempt') ?? '?'}/${numberField(message, 'max_retries') ?? '?'}${delay !== undefined ? ` in ${delay}ms` : ''}`,
        });
        return;
      }
      case 'permission_denied':
        this.emit({
          t: 'diagnostic',
          code: 'permission_denied',
          message: `${stringField(message, 'tool_name') ?? 'tool'} denied: ${scrubSecrets(clip(stringField(message, 'message') ?? '', 500))}`,
        });
        return;
      default:
        if (!QUIET_SYSTEM_SUBTYPES.has(subtype)) this.reportOnce(`system:${subtype}`, `Ignored unknown Claude Code system message ${subtype || '(no subtype)'}`);
    }
  }

  private onStreamEvent(message: Record<string, unknown>): void {
    const event = message.event;
    if (!isRecord(event)) return;
    if (event.type === 'message_start') {
      const inner = isRecord(event.message) ? event.message : {};
      this.currentStreamMessage = stringField(inner, 'id') ?? null;
      return;
    }
    if (event.type !== 'content_block_delta' || !isRecord(event.delta)) return;
    const delta = event.delta;
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
      if (this.currentStreamMessage) this.streamedMessages.add(this.currentStreamMessage);
      this.emit({ t: 'message.delta', text: delta.text });
    } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
      if (this.currentStreamMessage) this.streamedMessages.add(this.currentStreamMessage);
      this.emit({ t: 'reasoning.delta', text: delta.thinking });
    }
  }

  private onAssistant(message: Record<string, unknown>): void {
    const body = message.message;
    if (!isRecord(body)) {
      this.reportLine('invalid_event', 'Ignored an assistant message without a body');
      return;
    }
    const error = stringField(message, 'error');
    if (error) this.lastAssistantError = error;
    const id = stringField(body, 'id');
    if (id && isRecord(body.usage)) this.messageUsage.set(id, usageFromApi(body.usage));
    const mainThread = message.parent_tool_use_id === null || message.parent_tool_use_id === undefined;
    const content = Array.isArray(body.content) ? body.content : [];
    content.forEach((block, index) => {
      if (!isRecord(block)) return;
      if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        const callId = stringField(block, 'id');
        if (!callId || this.tools.has(callId)) return;
        const name = stringField(block, 'name') ?? 'tool';
        this.tools.set(callId, { name, input: block.input });
        this.emit({ t: 'tool.started', callId, name, input: block.input ?? {} });
        return;
      }
      if (typeof block.type === 'string' && block.type.endsWith('_tool_result')) {
        const callId = stringField(block, 'tool_use_id');
        const failed = isRecord(block.content) && typeof block.content.type === 'string' && block.content.type.endsWith('error');
        if (callId) this.finishTool(callId, !failed, '', undefined);
        return;
      }
      if (!mainThread || (id && this.streamedMessages.has(id))) return;
      const key = `${id ?? 'anon'}:${index}:${String(block.type)}`;
      if (this.emittedBlocks.has(key)) return;
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        this.emittedBlocks.add(key);
        this.emit({ t: 'message.delta', text: block.text });
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        this.emittedBlocks.add(key);
        this.emit({ t: 'reasoning.delta', text: block.thinking });
      }
    });
  }

  private onUser(message: Record<string, unknown>): void {
    const body = message.message;
    if (!isRecord(body) || !Array.isArray(body.content)) return;
    const results = body.content.filter((block): block is Record<string, unknown> => isRecord(block) && block.type === 'tool_result');
    for (const block of results) {
      const callId = stringField(block, 'tool_use_id');
      if (!callId) continue;
      const toolUseResult = results.length === 1 ? message.tool_use_result : undefined;
      this.finishTool(callId, block.is_error !== true, toolResultText(block.content), toolUseResult);
    }
  }

  private finishTool(callId: string, ok: boolean, output: string, toolUseResult: unknown): void {
    if (this.finishedTools.has(callId)) return;
    this.finishedTools.add(callId);
    let started = this.tools.get(callId);
    if (!started) {
      // Keep the lifecycle invariant (started before finished) for results
      // whose tool_use was not observed (e.g. emitted before a resume).
      started = { name: 'tool', input: {} };
      this.tools.set(callId, started);
      this.emit({ t: 'tool.started', callId, name: started.name, input: {} });
    }
    const summary = scrubSecrets(clip(output));
    this.emit({ t: 'tool.finished', callId, name: started.name, ok, ...(summary ? { summary } : {}) });
    const pathKey = FILE_TOOLS[started.name];
    if (!ok || !pathKey || !isRecord(started.input)) return;
    const raw = stringField(started.input, pathKey);
    if (!raw) return;
    const rel = isAbsolute(raw) ? relative(this.options.worktree, raw) : raw;
    const path = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : raw;
    const created = started.name === 'Write' && isRecord(toolUseResult) && toolUseResult.type === 'create';
    this.emit({ t: 'file.changed', path, kind: created ? 'create' : 'edit' });
  }

  private onControlResponse(message: Record<string, unknown>): void {
    const response = isRecord(message.response) ? message.response : null;
    const requestId = response ? stringField(response, 'request_id') : undefined;
    if (!response || !requestId) return;
    const pending = this.pendingControl.get(requestId);
    if (!pending) return;
    this.pendingControl.delete(requestId);
    pending.resolve(response);
  }

  private onControlRequest(message: Record<string, unknown>): void {
    const requestId = stringField(message, 'request_id');
    const request = isRecord(message.request) ? message.request : null;
    if (!requestId || !request) return;
    if (request.subtype === 'can_use_tool' && this.options.permissions.default === 'ask') {
      const toolName = stringField(request, 'tool_name') ?? 'tool';
      const input = isRecord(request.input) ? request.input : {};
      this.pendingPermissions.set(requestId, { toolName, input, toolUseId: stringField(request, 'tool_use_id') });
      // The whole input is what an allow runs, so the person sees all of it
      // (the approval digest covers exactly this text); only a very large
      // input is cut, and then visibly.
      const heading = stringField(request, 'title') ?? stringField(request, 'description');
      const detail = [heading, JSON.stringify(input, null, 2)].filter((part): part is string => Boolean(part)).join('\n\n');
      this.emit({ t: 'permission.requested', id: requestId, tool: toolName, detail: clip(scrubSecrets(detail), PERMISSION_DETAIL_LIMIT) });
      return;
    }
    const subtype = String(request.subtype ?? 'unknown');
    this.writeLine({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `OpenLinear does not answer ${subtype} requests` } });
    this.emit({ t: 'diagnostic', code: 'control_request_rejected', message: `Declined a ${subtype} control request from Claude Code` });
  }

  /** Sends a control request; resolves with the response, or null on timeout/exit. */
  private controlRequest(request: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
    this.controlCounter += 1;
    const requestId = `openlinear-${this.controlCounter}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pendingControl.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
      });
      if (!this.writeLine({ type: 'control_request', request_id: requestId, request })) {
        clearTimeout(timer);
        this.pendingControl.delete(requestId);
        resolve(null);
      }
      void this.whenTerminal().then(() => {
        const pending = this.pendingControl.get(requestId);
        if (!pending) return;
        this.pendingControl.delete(requestId);
        pending.resolve(null);
      });
    });
  }

  /**
   * In-band interrupt (the Agent SDK's `interrupt()`): a control_request the
   * CLI acknowledges with a control_response, followed by the interrupted
   * turn's result. Without an ack, or without the result within the grace
   * window, the caller escalates to terminating the process group.
   */
  protected async gracefulInterrupt(via: CancelVia): Promise<void> {
    if (!this.proc || this.proc.isExited() || !this.initSeen) return;
    const response = await this.controlRequest({ subtype: 'interrupt' }, this.options.interruptAckMs ?? INTERRUPT_ACK_MS);
    if (this.finished) return;
    if (response?.subtype !== 'success') {
      const reason = response ? scrubSecrets(clip(stringField(response, 'error') ?? 'error', 300)) : 'no acknowledgement';
      this.emit({ t: 'diagnostic', code: 'interrupt_unacknowledged', message: `Claude Code did not acknowledge the ${via} (${reason}); stopping the process` });
      return;
    }
    this.interruptAcked = true;
    await Promise.race([this.whenTerminal(), new Promise<void>((resolve) => setTimeout(resolve, this.killGraceMs).unref?.())]);
  }

  onPermissionWithdrawn(listener: (id: string) => void): () => void {
    this.withdrawnListeners.add(listener);
    return () => {
      this.withdrawnListeners.delete(listener);
    };
  }

  async replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void> {
    const pending = this.pendingPermissions.get(id);
    if (!pending) {
      // Withdrawn by Claude Code (or already answered): nothing is waiting for this reply.
      this.emit({ t: 'diagnostic', code: 'permission_reply_unneeded', message: `Permission request ${id} no longer waits for an answer` });
      return;
    }
    this.pendingPermissions.delete(id);
    const response = decision === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: pending.input,
          ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}),
          ...(scope === 'session'
            ? { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: pending.toolName }], behavior: 'allow', destination: 'session' }] }
            : {}),
        }
      : { behavior: 'deny', message: 'Denied by the OpenLinear user', ...(pending.toolUseId ? { toolUseID: pending.toolUseId } : {}) };
    if (!this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: id, response } })) {
      throw new Error('Claude Code is no longer accepting input');
    }
  }

  private onResult(message: Record<string, unknown>): void {
    const subtype = stringField(message, 'subtype') ?? 'unknown';
    const terminalReason = stringField(message, 'terminal_reason');
    const isError = message.is_error === true;
    const usageEvents = this.usageEvents(message);
    const aborted = terminalReason === 'aborted_streaming' || terminalReason === 'aborted_tools';
    if (this.cancelVia && (aborted || subtype === 'error_during_execution' || (isError && this.interruptAcked))) {
      this.finish([...usageEvents, { t: 'cancel.receipt', via: this.cancelVia, confirmedBy: 'runner-ack' }], 'interrupted');
      return;
    }
    if (subtype === 'success' && !isError) {
      this.finish(usageEvents, 'idle');
      return;
    }
    if (subtype === 'error_max_turns' || terminalReason === 'max_turns') {
      this.finish([...usageEvents, { t: 'diagnostic', code: 'max_turns', message: 'Claude Code stopped at the maximum number of turns' }], 'max_turns');
      return;
    }
    const classification = classifyClaudeFailure({
      subtype,
      terminalReason,
      apiErrorStatus: numberField(message, 'api_error_status'),
      assistantError: this.lastAssistantError,
    });
    const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === 'string') : [];
    const text = stringField(message, 'result') ?? errors.join('; ');
    const detail = text || `Claude Code ended with ${subtype}${terminalReason ? ` (${terminalReason})` : ''}`;
    this.finish([
      ...usageEvents,
      { t: 'error', code: classification.code, message: scrubSecrets(clip(detail, 2000)), retryable: classification.retryable },
    ], 'error');
  }

  /**
   * One `usage` delta per run. A fresh session's result totals are this run.
   * A resumed session's result totals are conversation-cumulative, so the
   * baseline recorded at the end of the previous run is subtracted; the
   * per-message sum observed in this run is the lower bound either way.
   */
  private usageEvents(message: Record<string, unknown>): AgentEvent[] {
    const reported = usageFromModelUsage(message.modelUsage) ?? (isRecord(message.usage) ? usageFromApi(message.usage) : null);
    const reportedCost = numberField(message, 'total_cost_usd');
    let observed = emptyTokenUsage();
    for (const usage of this.messageUsage.values()) observed = addTokenUsage(observed, usage);
    if (reported) {
      writeSessionUsage('claude-code', this.sessionId, {
        usage: reported,
        costUsd: reportedCost ?? 0,
        updatedAt: new Date().toISOString(),
      }, this.options.env);
    }
    let usage: TokenUsage;
    let cost: number | undefined;
    let basis: string;
    if (reported && !this.options.resumed) {
      usage = tokenTotal(reported) >= tokenTotal(observed) ? reported : observed;
      cost = reportedCost;
      basis = 'claude-code total_cost_usd (client-side estimate)';
    } else if (reported && this.baseline) {
      const delta = subtractUsage(reported, this.baseline.usage);
      usage = tokenTotal(delta) >= tokenTotal(observed) ? delta : observed;
      cost = reportedCost !== undefined ? Math.max(0, reportedCost - this.baseline.costUsd) : undefined;
      basis = 'claude-code total_cost_usd minus the previous run (client-side estimate)';
    } else {
      usage = observed;
      cost = undefined;
      basis = 'per-message usage observed in this run (lower bound)';
    }
    if (tokenTotal(usage) === 0 && cost === undefined) return [];
    return [{ t: 'usage', usage, ...(cost !== undefined ? { cost: { usd: cost, basis } } : {}) }];
  }
}
