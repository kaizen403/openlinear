import type {
  AgentEvent,
  AgentRunner,
  AgentSession,
  ModelDescriptor,
  ModelRef,
  ResumeInput,
  RunnerCapabilities,
  StartInput,
  TokenUsage,
} from '@openlinear/execution-core';
import { emptyTokenUsage } from '@openlinear/execution-core';
import type { CodexOptions, Thread, ThreadEvent, ThreadOptions } from '@openai/codex-sdk';

const CAPABILITIES: RunnerCapabilities = {
  streamingDeltas: true,
  reasoningDeltas: true,
  permissionReply: false,
  interrupt: true,
  compact: false,
  revert: false,
  fork: false,
  cacheSplitUsage: true,
};

type CodexThread = Pick<Thread, 'id' | 'runStreamed'>;

type CodexCtor = new (opts?: CodexOptions) => {
  startThread(opts?: ThreadOptions): CodexThread;
  resumeThread(id: string, opts?: ThreadOptions): CodexThread;
};

interface CodexEventState {
  externalId?: string;
  textByItem: Map<string, string>;
  startedTools: Set<string>;
  completedItems: Set<string>;
  usage: TokenUsage;
  turn: number;
  terminal: boolean;
}

function createEventState(): CodexEventState {
  return {
    textByItem: new Map(),
    startedTools: new Set(),
    completedItems: new Set(),
    usage: emptyTokenUsage(),
    turn: 0,
    terminal: false,
  };
}

function textDelta(state: CodexEventState, key: string, next: string): string {
  const previous = state.textByItem.get(key) ?? '';
  if (next === previous || previous.startsWith(next)) return '';
  state.textByItem.set(key, next);
  return next.startsWith(previous) ? next.slice(previous.length) : next;
}

export function decodeCodexEvent(
  event: ThreadEvent,
  state: CodexEventState,
  model: ModelRef = { provider: 'openai', id: 'unknown' },
): AgentEvent[] {
  if (state.terminal) return [];
  const out: AgentEvent[] = [];
  switch (event.type) {
    case 'thread.started':
      if (state.externalId !== event.thread_id) {
        state.externalId = event.thread_id;
        out.push({ t: 'session.started', externalId: event.thread_id, model });
      }
      break;
    case 'turn.started':
      state.turn += 1;
      out.push({ t: 'turn.started', turn: state.turn });
      break;
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = event.item;
      if (state.completedItems.has(item.id)) break;
      if (item.type === 'agent_message' || item.type === 'reasoning') {
        const delta = textDelta(state, item.id, item.text);
        if (delta) out.push({ t: item.type === 'agent_message' ? 'message.delta' : 'reasoning.delta', text: delta });
      }
      if (item.type === 'command_execution') {
        if (!state.startedTools.has(item.id)) {
          state.startedTools.add(item.id);
          out.push({ t: 'tool.started', callId: item.id, name: 'bash', input: { command: item.command } });
        }
        const previous = state.textByItem.get(item.id) ?? '';
        const chunk = textDelta(state, item.id, item.aggregated_output);
        if (chunk) {
          out.push({
            t: 'tool.output', callId: item.id, chunk,
            cumulative: !item.aggregated_output.startsWith(previous),
          });
        }
        if (event.type === 'item.completed') {
          out.push({
            t: 'tool.finished', callId: item.id, name: 'bash',
            ok: item.status === 'completed' && (item.exit_code === undefined || item.exit_code === 0),
            summary: item.aggregated_output,
          });
        }
      }
      if (item.type === 'mcp_tool_call') {
        const name = `${item.server}.${item.tool}`;
        if (!state.startedTools.has(item.id)) {
          state.startedTools.add(item.id);
          out.push({ t: 'tool.started', callId: item.id, name, input: item.arguments });
        }
        if (event.type === 'item.completed') {
          out.push({
            t: 'tool.finished', callId: item.id, name,
            ok: item.status === 'completed' && !item.error,
            summary: item.error?.message ?? (item.result ? JSON.stringify(item.result) : undefined),
          });
        }
      }
      if (item.type === 'file_change' && event.type === 'item.completed') {
        out.push({ t: 'tool.finished', callId: item.id, name: 'apply_patch', ok: item.status === 'completed' });
        if (item.status === 'completed') {
          for (const change of item.changes) {
            out.push({
              t: 'file.changed', path: change.path,
              kind: change.kind === 'add' ? 'create' : change.kind === 'delete' ? 'delete' : 'edit',
            });
          }
        }
      }
      if (item.type === 'error' && event.type === 'item.completed') {
        out.push({ t: 'tool.finished', callId: item.id, name: 'codex', ok: false, summary: item.message });
      }
      if (event.type === 'item.completed') state.completedItems.add(item.id);
      break;
    }
    case 'turn.completed':
      state.usage = {
        input: event.usage.input_tokens,
        output: event.usage.output_tokens,
        cacheRead: event.usage.cached_input_tokens,
        cacheWrite: event.usage.cache_write_input_tokens,
        reasoning: event.usage.reasoning_output_tokens,
      };
      out.push({ t: 'usage', usage: state.usage });
      out.push({ t: 'turn.finished', turn: state.turn, reason: 'idle' });
      state.terminal = true;
      break;
    case 'turn.failed':
    case 'error':
      out.push({
        t: 'error',
        code: 'codex',
        message: event.type === 'error' ? event.message : event.error.message,
        retryable: false,
      });
      out.push({ t: 'turn.finished', turn: state.turn, reason: 'error' });
      state.terminal = true;
      break;
  }
  return out;
}

class CodexSession implements AgentSession {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private consumed = false;

  constructor(
    private readonly thread: CodexThread,
    private readonly prompt: string,
    signal: AbortSignal,
    private readonly initialId: string,
    private readonly model?: ModelRef,
  ) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
  }

  get externalId(): string {
    // New SDK threads receive their resumable ID only while consuming thread.started.
    return this.thread.id ?? this.initialId;
  }

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        if (self.consumed) throw new Error('Codex session events can only be consumed once');
        self.consumed = true;
        const state = createEventState();
        try {
          if (self.signal.aborted) {
            yield { t: 'turn.finished', turn: state.turn, reason: 'interrupted' };
            return;
          }
          if (self.thread.id) {
            for (const decoded of decodeCodexEvent({ type: 'thread.started', thread_id: self.thread.id }, state, self.model)) {
              yield decoded;
            }
          }
          const { events } = await self.thread.runStreamed(self.prompt, { signal: self.signal });
          for await (const event of events) {
            if (self.signal.aborted) {
              yield { t: 'turn.finished', turn: state.turn, reason: 'interrupted' };
              return;
            }
            for (const decoded of decodeCodexEvent(event, state, self.model)) yield decoded;
            if (state.terminal) return;
          }
          if (self.signal.aborted) {
            yield { t: 'turn.finished', turn: state.turn, reason: 'interrupted' };
          } else {
            yield { t: 'error', code: 'codex', message: 'Codex stream closed before the turn ended', retryable: false };
            yield { t: 'turn.finished', turn: state.turn, reason: 'error' };
          }
        } catch (error) {
          if (state.terminal) return;
          if (self.signal.aborted) {
            yield { t: 'turn.finished', turn: state.turn, reason: 'interrupted' };
          } else {
            yield { t: 'error', code: 'codex', message: error instanceof Error ? error.message : 'Codex execution failed', retryable: false };
            yield { t: 'turn.finished', turn: state.turn, reason: 'error' };
          }
        } finally {
          // Closing the SDK iterator cleans up its CLI child; abort also covers early consumers.
          self.controller.abort();
        }
      },
    };
  }

  async interrupt(): Promise<void> {
    // The SDK exposes signal-driven cancellation, not app-server's graceful interrupt RPC.
    this.controller.abort();
  }

  async abort(): Promise<void> {
    this.controller.abort();
  }

  async replyPermission(): Promise<void> {
    throw new Error('Codex SDK does not support interactive permission replies');
  }
}

export class CodexRunner implements AgentRunner {
  readonly id = 'codex' as const;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly createSdk: () => Promise<CodexCtor> = loadCodexCtor) {}

  async healthCheck() {
    try {
      const Codex = await this.createSdk();
      new Codex();
      return { ok: true, detail: 'Codex SDK and CLI binary located; execution and authentication are not checked' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'codex unavailable' };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // This SDK has no model discovery API. Account-aware discovery belongs to another surface.
    return [];
  }

  async start(input: StartInput): Promise<AgentSession> {
    const Codex = await this.createSdk();
    const sdk = new Codex({ apiKey: input.env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY });
    const thread = sdk.startThread({
      workingDirectory: input.worktreePath,
      model: input.model?.id,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
    return new CodexSession(
      thread,
      `${input.systemContract}\n\n${input.prompt}`,
      input.signal,
      input.runId,
      input.model,
    );
  }

  async resume(externalSessionId: string, input: ResumeInput): Promise<AgentSession> {
    const Codex = await this.createSdk();
    const sdk = new Codex({ apiKey: process.env.OPENAI_API_KEY });
    const thread = sdk.resumeThread(externalSessionId, {
      workingDirectory: input.worktreePath,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
    return new CodexSession(
      thread,
      'Continue the interrupted task from the saved conversation and current repository state. Verify completed work before repeating any actions.',
      input.signal,
      externalSessionId,
    );
  }
}

async function loadCodexCtor(): Promise<CodexCtor> {
  const mod = await import('@openai/codex-sdk');
  return mod.Codex;
}
