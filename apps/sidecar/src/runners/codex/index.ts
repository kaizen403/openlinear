import type {
  AgentEvent,
  AgentRunner,
  AgentSession,
  ModelDescriptor,
  ResumeInput,
  RunnerCapabilities,
  StartInput,
  TokenUsage,
} from '@openlinear/execution-core';
import { emptyTokenUsage } from '@openlinear/execution-core';

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

type CodexCtor = new (opts?: { apiKey?: string }) => {
  startThread(opts: { workingDirectory: string; sandboxMode?: string; approvalPolicy?: string }): {
    id?: string;
    runStreamed(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
  };
  resumeThread(id: string, opts: { workingDirectory: string; sandboxMode?: string; approvalPolicy?: string }): {
    id?: string;
    runStreamed(prompt: string, opts?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
  };
};

interface CodexThreadEvent {
  type: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    aggregated_output?: string;
    id?: string;
    name?: string;
    path?: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
}

export function decodeCodexEvent(
  event: CodexThreadEvent,
  highWater: { output: string; usage: TokenUsage },
): AgentEvent[] {
  const out: AgentEvent[] = [];
  switch (event.type) {
    case 'thread.started':
      out.push({ t: 'session.started', externalId: event.thread_id ?? 'codex', model: { id: 'codex' } });
      break;
    case 'turn.started':
      out.push({ t: 'turn.started', turn: 0 });
      break;
    case 'item.updated':
    case 'item.completed': {
      const item = event.item;
      if (!item) break;
      if (item.type === 'agent_message' && item.text) {
        const previous = highWater.output;
        const next = item.aggregated_output ?? item.text;
        if (next.startsWith(previous)) {
          const delta = next.slice(previous.length);
          if (delta) out.push({ t: 'message.delta', text: delta });
          highWater.output = next;
        } else if (item.text) {
          out.push({ t: 'message.delta', text: item.text });
        }
      }
      if (item.type === 'command_execution' && event.type === 'item.completed') {
        out.push({ t: 'tool.finished', callId: item.id ?? 'cmd', name: item.name ?? 'bash', ok: true });
      }
      if (item.type === 'file_change' && item.path) {
        out.push({ t: 'file.changed', path: item.path, kind: 'edit' });
      }
      break;
    }
    case 'turn.completed':
      if (event.usage) {
        highWater.usage = {
          input: event.usage.input_tokens ?? 0,
          output: event.usage.output_tokens ?? 0,
          cacheRead: event.usage.cached_input_tokens ?? 0,
          cacheWrite: 0,
          reasoning: event.usage.reasoning_output_tokens ?? 0,
        };
        out.push({ t: 'usage', usage: highWater.usage });
      }
      out.push({ t: 'turn.finished', turn: 0, reason: 'idle' });
      break;
    case 'turn.failed':
    case 'thread.error':
      out.push({
        t: 'error',
        code: 'codex',
        message: event.error?.message ?? 'Codex turn failed',
        retryable: false,
      });
      break;
    default:
      break;
  }
  return out;
}

class CodexSession implements AgentSession {
  readonly externalId: string;
  constructor(
    private readonly thread: {
      runStreamed: (prompt: string, opts?: { signal?: AbortSignal }) => Promise<{ events: AsyncIterable<CodexThreadEvent> }>;
    },
    private readonly prompt: string,
    private readonly signal: AbortSignal,
    externalId: string,
  ) {
    this.externalId = externalId;
  }

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const { events } = await self.thread.runStreamed(self.prompt, { signal: self.signal });
        const highWater = { output: '', usage: emptyTokenUsage() };
        for await (const event of events) {
          if (self.signal.aborted) {
            yield { t: 'turn.finished', turn: 0, reason: 'interrupted' };
            return;
          }
          for (const decoded of decodeCodexEvent(event, highWater)) {
            yield decoded;
          }
        }
      },
    };
  }

  async interrupt(): Promise<void> {
    // Codex CLI abort is signal-driven.
  }

  async abort(): Promise<void> {
    // Caller aborts the AbortSignal.
  }

  async replyPermission(): Promise<void> {
    // approvals: never — T1 is the later sandbox boundary
  }
}

export class CodexRunner implements AgentRunner {
  readonly id = 'codex' as const;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly createSdk: () => Promise<CodexCtor> = loadCodexCtor) {}

  async healthCheck() {
    try {
      await this.createSdk();
      return { ok: true, version: 'codex-sdk' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : 'codex unavailable' };
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [
      { id: 'codex', provider: 'openai', name: 'Codex' },
      { id: 'gpt-5-codex', provider: 'openai', name: 'GPT-5 Codex' },
    ];
  }

  async start(input: StartInput): Promise<AgentSession> {
    const Codex = await this.createSdk();
    const sdk = new Codex({ apiKey: input.env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY });
    const thread = sdk.startThread({
      workingDirectory: input.worktreePath,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    });
    return new CodexSession(
      thread,
      `${input.systemContract}\n\n${input.prompt}`,
      input.signal,
      thread.id ?? input.runId,
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
    return new CodexSession(thread, '', input.signal, externalSessionId);
  }
}

async function loadCodexCtor(): Promise<CodexCtor> {
  const mod = await import('@openai/codex-sdk') as { Codex: CodexCtor };
  return mod.Codex;
}
