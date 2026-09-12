import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
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
import { getClientForUser, getOpenCodeStatus } from '../../services/opencode';
import { EXECUTION_SYSTEM_CONTRACT } from '../../engine/system-contract';

const CAPABILITIES: RunnerCapabilities = {
  streamingDeltas: true,
  reasoningDeltas: true,
  permissionReply: true,
  interrupt: true,
  compact: true,
  revert: true,
  fork: true,
  cacheSplitUsage: true,
};

type LooseClient = OpencodeClient & {
  session: OpencodeClient['session'] & {
    promptAsync?: (args: unknown) => Promise<{ error?: unknown }>;
    interrupt?: (args: unknown) => Promise<unknown>;
    abort?: (args: unknown) => Promise<unknown>;
    compact?: (args: unknown) => Promise<unknown>;
    revert?: (args: unknown) => Promise<unknown>;
    init?: (args: unknown) => Promise<unknown>;
    children?: (args: unknown) => Promise<{ data?: Array<{ id?: string }> }>;
    event?: { subscribe?: (args: unknown) => Promise<{ stream: AsyncIterable<unknown> }> };
  };
  event?: { subscribe?: () => Promise<{ stream: AsyncIterable<unknown> }> };
  permission?: { reply?: (args: unknown) => Promise<unknown> };
};

function eventProps(event: { type?: string; properties?: Record<string, unknown>; data?: Record<string, unknown> }): Record<string, unknown> {
  return (event.properties ?? event.data ?? {}) as Record<string, unknown>;
}

function extractSessionId(event: { type?: string; properties?: Record<string, unknown>; data?: Record<string, unknown> }): string | undefined {
  const props = eventProps(event);
  const direct = props.sessionID ?? props.sessionId ?? props.id;
  return typeof direct === 'string' ? direct : undefined;
}

export function decodeOpenCodeEvent(event: {
  type?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}, usageHighWater: { tokens: TokenUsage }): AgentEvent | AgentEvent[] | null {
  const type = event.type ?? '';
  const props = eventProps(event);

  if (type === 'server.heartbeat') return { t: 'heartbeat' };
  if (type === 'session.created' || type === 'session.started') {
    const id = (props.id ?? props.sessionID) as string | undefined;
    return { t: 'session.started', externalId: id ?? 'unknown', model: { id: String(props.model ?? 'unknown') } };
  }
  if (type === 'session.idle') return { t: 'turn.finished', turn: 0, reason: 'idle' };
  if (type === 'session.error') {
    const error = props.error as { name?: string; data?: { message?: string } } | undefined;
    const message = error?.data?.message || error?.name || 'session error';
    const retryable = /rate.?limit|429|5\d\d/i.test(message);
    return { t: 'error', code: retryable ? 'rate_limit' : 'session', message, retryable };
  }
  if (type === 'session.compacted') return { t: 'compaction', phase: 'end' };
  if (type === 'permission.updated') {
    const id = String(props.id ?? '');
    return { t: 'permission.requested', id, tool: String(props.type ?? 'unknown'), detail: String(props.title ?? '') };
  }
  if (type === 'file.edited') {
    const file = String(props.file ?? '');
    return file ? { t: 'file.changed', path: file, kind: 'edit' } : null;
  }
  if (type === 'message.part.updated') {
    const part = props.part as { type?: string; text?: string; tool?: string; id?: string; callID?: string; state?: { status?: string; output?: string } } | undefined;
    const delta = typeof props.delta === 'string' ? props.delta : '';
    if (part?.type === 'text' && delta) return { t: 'message.delta', text: delta };
    if (part?.type === 'reasoning' && delta) return { t: 'reasoning.delta', text: delta };
    if (part?.type === 'compaction') return { t: 'compaction', phase: 'start' };
    if (part?.type === 'tool') {
      const callId = String(part.callID ?? part.id ?? 'tool');
      if (part.state?.status === 'running') {
        return { t: 'tool.started', callId, name: String(part.tool ?? 'tool'), input: props };
      }
      if (part.state?.status === 'completed' || part.state?.status === 'error') {
        return { t: 'tool.finished', callId, name: String(part.tool ?? 'tool'), ok: part.state.status === 'completed', summary: part.state.output };
      }
    }
  }
  if (type === 'message.updated') {
    const info = props.info as {
      role?: string;
      id?: string;
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
      cost?: number;
    } | undefined;
    if (info?.role !== 'assistant') return null;
    const usage: TokenUsage = {
      input: info.tokens?.input ?? 0,
      output: info.tokens?.output ?? 0,
      reasoning: info.tokens?.reasoning ?? 0,
      cacheRead: info.tokens?.cache?.read ?? 0,
      cacheWrite: info.tokens?.cache?.write ?? 0,
    };
    usageHighWater.tokens = usage;
    return { t: 'usage', usage, cost: { usd: info.cost ?? 0 }, messageId: info.id };
  }
  if (type === 'session.child.idle' || (type === 'session.idle' && props.parentID)) {
    return { t: 'turn.finished', turn: 0, reason: 'idle' };
  }
  return null;
}

class OpenCodeSession implements AgentSession {
  readonly externalId: string;
  private readonly client: LooseClient;
  private readonly directory: string;
  private readonly signal: AbortSignal;
  private readonly userPrompt: string;
  private readonly systemContract: string;
  private readonly model?: { providerID?: string; modelID?: string };

  constructor(opts: {
    client: LooseClient;
    sessionId: string;
    directory: string;
    signal: AbortSignal;
    prompt: string;
    systemContract: string;
    model?: { providerID?: string; modelID?: string };
  }) {
    this.client = opts.client;
    this.externalId = opts.sessionId;
    this.directory = opts.directory;
    this.signal = opts.signal;
    this.userPrompt = opts.prompt;
    this.systemContract = opts.systemContract;
    this.model = opts.model;
  }

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        yield { t: 'session.started', externalId: self.externalId, model: { id: self.model?.modelID ?? 'opencode' } };
        const promptBody = {
          path: { id: self.externalId },
          body: {
            parts: [
              { type: 'text', text: `${self.systemContract}\n\n${self.userPrompt}` },
            ],
            ...(self.model ? { model: self.model } : {}),
          },
        };
        const promptFn = self.client.session.promptAsync ?? self.client.session.prompt;
        const subscribed = self.client.session.event?.subscribe
          ? await self.client.session.event.subscribe({ path: { id: self.externalId } })
          : await self.client.event?.subscribe?.();
        if (!subscribed) throw new Error('OpenCode event subscribe is unavailable');
        const promptResult = await promptFn.call(self.client.session, promptBody);
        if (promptResult && typeof promptResult === 'object' && 'error' in promptResult && promptResult.error) {
          yield { t: 'error', code: 'prompt', message: String(promptResult.error), retryable: false };
          return;
        }
        const usageHighWater = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
        for await (const raw of subscribed.stream) {
          if (self.signal.aborted) {
            yield { t: 'turn.finished', turn: 0, reason: 'interrupted' };
            return;
          }
          const decoded = decodeOpenCodeEvent(raw as { type?: string; properties?: Record<string, unknown>; data?: Record<string, unknown> }, usageHighWater);
          if (!decoded) continue;
          const events = Array.isArray(decoded) ? decoded : [decoded];
          for (const item of events) {
            const sid = extractSessionId(raw as { type?: string; properties?: Record<string, unknown>; data?: Record<string, unknown> });
            if (sid && sid !== self.externalId) {
              // Child session traffic: only surface idle/error, not parent completion.
              if (item.t === 'turn.finished') continue;
            }
            yield item;
            if (item.t === 'turn.finished' || item.t === 'error') return;
          }
        }
      },
    };
  }

  async interrupt(): Promise<void> {
    if (this.client.session.interrupt) {
      await this.client.session.interrupt({ path: { id: this.externalId } });
      return;
    }
    await this.abort();
  }

  async abort(): Promise<void> {
    if (this.client.session.abort) {
      await this.client.session.abort({ path: { id: this.externalId } });
    }
  }

  async replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void> {
    const reply = decision === 'deny' ? 'reject' : scope === 'session' ? 'always' : 'once';
    if (this.client.permission?.reply) {
      await this.client.permission.reply({ path: { id }, body: { reply } });
    }
  }

  async compact(): Promise<void> {
    await this.client.session.compact?.({ path: { id: this.externalId } });
  }
}

export class OpenCodeRunner implements AgentRunner {
  readonly id = 'opencode' as const;
  readonly capabilities = CAPABILITIES;

  constructor(private readonly resolveClient: (directory: string) => Promise<LooseClient> = defaultClient) {}

  async healthCheck() {
    const status = getOpenCodeStatus();
    return { ok: status.running, detail: status.serverUrl ?? undefined, version: '1.18' };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    try {
      const client = await this.resolveClient(process.cwd());
      const list = await client.provider.list();
      const payload = list.data as { all?: Array<{ id: string; models?: Record<string, { name?: string }> }> };
      const out: ModelDescriptor[] = [];
      for (const provider of payload?.all ?? []) {
        for (const [modelId, meta] of Object.entries(provider.models ?? {})) {
          out.push({ id: `${provider.id}/${modelId}`, provider: provider.id, name: meta?.name });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async start(input: StartInput): Promise<AgentSession> {
    const client = await this.resolveClient(input.worktreePath);
    await client.session.init?.({ body: { directory: input.worktreePath } }).catch(() => undefined);
    const created = await client.session.create({
      body: { title: `openlinear:${input.runId}` },
      ...( { directory: input.worktreePath } as Record<string, unknown> ),
    });
    const sessionId = (created as { data?: { id?: string } }).data?.id;
    if (!sessionId) throw new Error('OpenCode session.create returned no id');
    const model = input.model
      ? { providerID: input.model.provider ?? input.model.id.split('/')[0], modelID: input.model.id.split('/').slice(1).join('/') || input.model.id }
      : undefined;
    return new OpenCodeSession({
      client,
      sessionId,
      directory: input.worktreePath,
      signal: input.signal,
      prompt: input.prompt,
      systemContract: input.systemContract || EXECUTION_SYSTEM_CONTRACT,
      model,
    });
  }

  async resume(externalSessionId: string, input: ResumeInput): Promise<AgentSession> {
    const client = await this.resolveClient(input.worktreePath);
    return new OpenCodeSession({
      client,
      sessionId: externalSessionId,
      directory: input.worktreePath,
      signal: input.signal,
      prompt: '',
      systemContract: EXECUTION_SYSTEM_CONTRACT,
    });
  }
}

async function defaultClient(directory: string): Promise<LooseClient> {
  try {
    return await getClientForUser('system', directory) as LooseClient;
  } catch {
    const v2 = await import('@opencode-ai/sdk/v2').catch(() => null) as { createOpencodeClient?: typeof createOpencodeClient } | null;
    if (v2?.createOpencodeClient) {
      return v2.createOpencodeClient({ baseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096' }) as LooseClient;
    }
    return createOpencodeClient({
      baseUrl: process.env.OPENCODE_BASE_URL || 'http://127.0.0.1:4096',
      directory,
    }) as LooseClient;
  }
}
