import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk';
import type {
  AgentEvent,
  AgentRunner,
  AgentSession,
  ModelDescriptor,
  ResumeInput,
  RunnerCapabilities,
  RunnerFeatures,
  RunnerHealth,
  StartInput,
  TokenUsage,
} from '@openlinear/execution-core';
import { getClientForUser, getOpenCodeStatus } from '../../services/opencode';
import { SandboxStartError, SandboxUnavailableError } from '../../sandbox/errors';
import { EXECUTION_SYSTEM_CONTRACT } from '../../engine/system-contract';
import { RESUME_CONTINUATION_PROMPT } from '../shared/continuation';
import { scrubSecrets } from '../shared/process-session';

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

const FEATURES: RunnerFeatures = {
  resume: 'native-session',
  interrupt: 'server-abort',
  approvals: 'interactive',
  models: { discovery: 'live', aliases: [], passthrough: true },
  maxContextTokens: null,
  usage: { cost: 'reported', cacheSplit: true, reasoning: true, semantics: 'snapshot-per-message' },
  isolation: 'sandbox-provider-server',
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

interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvent(raw: unknown): OpenCodeEvent | null {
  if (!isRecord(raw)) return null;
  // /global/event envelopes carry the same SDK event under `payload`.
  const event = isRecord(raw.payload) ? raw.payload : raw;
  if (typeof event.type !== 'string') return null;
  return {
    type: event.type,
    properties: isRecord(event.properties) ? event.properties : undefined,
    data: isRecord(event.data) ? event.data : undefined,
  };
}

function eventProps(event: { properties?: Record<string, unknown>; data?: Record<string, unknown> }): Record<string, unknown> {
  return event.properties ?? event.data ?? {};
}

function extractSessionId(event: OpenCodeEvent): string | undefined {
  const props = eventProps(event);
  // 1.x nests ownership in message info/parts; 1.18 v2 also carries a direct
  // sessionID in properties or native-event data. Generic ids identify events,
  // messages or permission requests, and must never authorize a session.
  const owners: unknown[] = [];
  for (const key of ['sessionID', 'sessionId']) {
    if (key in props) owners.push(props[key]);
  }
  if (isRecord(props.info)) {
    if ('sessionID' in props.info) owners.push(props.info.sessionID);
    if (['session.created', 'session.updated', 'session.deleted'].includes(event.type)) {
      if ('id' in props.info) owners.push(props.info.id);
    }
  }
  if (isRecord(props.part) && 'sessionID' in props.part) owners.push(props.part.sessionID);
  const owner = owners[0];
  if (typeof owner !== 'string' || !owner || owners.some((candidate) => candidate !== owner)) return undefined;
  return owner;
}

const MAX_PERMISSION_DETAIL = 8_000;

/** What an OpenCode 1.x permission request covers, as reviewable text (bounded, secrets scrubbed). */
function permissionDetail(props: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof props.title === 'string' && props.title.trim()) parts.push(props.title.trim());
  const patterns = Array.isArray(props.patterns) ? props.patterns.filter((value): value is string => typeof value === 'string') : [];
  if (patterns.length > 0) parts.push(patterns.join('\n'));
  if (isRecord(props.metadata) && Object.keys(props.metadata).length > 0) parts.push(JSON.stringify(props.metadata, null, 2));
  const text = scrubSecrets(parts.join('\n\n'));
  return text.length > MAX_PERMISSION_DETAIL ? `${text.slice(0, MAX_PERMISSION_DETAIL)}\n… (${text.length - MAX_PERMISSION_DETAIL} more characters not shown)` : text;
}

export function decodeOpenCodeEvent(event: {
  type?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}, usageHighWater: { tokens: TokenUsage; partTypes?: Map<string, 'text' | 'reasoning'> }): AgentEvent | AgentEvent[] | null {
  const type = event.type ?? '';
  const props = eventProps(event);

  if (type === 'server.heartbeat' || type === 'server.connected') return { t: 'heartbeat' };
  if (type === 'session.created' || type === 'session.started') {
    const id = extractSessionId({ ...event, type });
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
  // OpenCode 1.x (the bundled server): `permission.asked` names the
  // permission (edit / bash / webfetch …) and what it covers (patterns,
  // metadata such as the command or the file and diff). The detail shows it
  // all (secrets scrubbed); the approval digest covers exactly this text.
  if (type === 'permission.asked') {
    const id = String(props.id ?? '');
    return { t: 'permission.requested', id, tool: String(props.permission ?? props.type ?? 'unknown'), detail: permissionDetail(props) };
  }
  if (type === 'file.edited') {
    const file = String(props.file ?? '');
    return file ? { t: 'file.changed', path: file, kind: 'edit' } : null;
  }
  if (type === 'message.part.updated') {
    const part = props.part as { type?: string; text?: string; tool?: string; id?: string; callID?: string; state?: { status?: string; output?: string } } | undefined;
    const delta = typeof props.delta === 'string' ? props.delta : '';
    if (part?.id && (part.type === 'text' || part.type === 'reasoning')) {
      if (!usageHighWater.partTypes) usageHighWater.partTypes = new Map();
      usageHighWater.partTypes.set(part.id, part.type);
    }
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
  if (type === 'message.part.delta' && props.field === 'text' && typeof props.delta === 'string') {
    const partType = usageHighWater.partTypes?.get(String(props.partID ?? ''));
    if (partType === 'text') return { t: 'message.delta', text: props.delta };
    if (partType === 'reasoning') return { t: 'reasoning.delta', text: props.delta };
  }
  if (type === 'message.part.removed') {
    usageHighWater.partTypes?.delete(String(props.partID ?? ''));
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

/** Event types this adapter decodes or deliberately ignores (anything else is reported once). */
const KNOWN_EVENT_TYPES = new Set([
  'server.connected', 'server.heartbeat', 'session.created', 'session.started', 'session.updated',
  'session.idle', 'session.error', 'session.compacted', 'session.status', 'session.diff',
  'permission.updated', 'permission.asked', 'permission.replied', 'file.edited', 'message.part.updated', 'message.part.delta',
  'message.part.removed', 'message.updated', 'message.removed', 'session.child.idle', 'todo.updated',
]);

const MAX_MALFORMED_DIAGNOSTICS = 20;
const ABORT_TIMEOUT_MS = 5_000;

type CancelVia = 'interrupt' | 'abort' | 'signal';

/**
 * The only positive stop receipt OpenCode gives: the abort route answering
 * `true` (hey-api returns `{ data, error }` instead of throwing, so a
 * resolved call alone proves nothing — an error body, `false`, or a missing
 * body is not a receipt).
 */
export function isOpenCodeAbortReceipt(result: unknown): boolean {
  if (result === true) return true;
  if (!isRecord(result)) return false;
  return (result.error === undefined || result.error === null) && result.data === true;
}

/**
 * Ask OpenCode to abort a session and report whether it confirmed. Never
 * throws: transport failures and timeouts are unconfirmed.
 */
export async function confirmOpenCodeAbort(
  client: { session: { abort?: (args: { path: { id: string }; signal?: AbortSignal }) => Promise<unknown> } },
  sessionId: string,
  timeoutMs = ABORT_TIMEOUT_MS,
): Promise<boolean> {
  if (!client.session.abort) return false;
  try {
    return isOpenCodeAbortReceipt(await client.session.abort({ path: { id: sessionId }, signal: AbortSignal.timeout(timeoutMs) }));
  } catch {
    return false;
  }
}

class OpenCodeSession implements AgentSession {
  readonly externalId: string;
  private readonly client: LooseClient;
  private readonly directory: string;
  private readonly signal: AbortSignal;
  private readonly userPrompt: string;
  private readonly systemContract: string;
  private readonly model?: { providerID?: string; modelID?: string };
  private cancelRequest: Promise<{ via: CancelVia; acknowledged: boolean }> | null = null;
  /** Settled result of `cancelRequest` (null while in flight or never sent). */
  private cancelSettled: { via: CancelVia; acknowledged: boolean } | null = null;
  private resolveCancelRequested!: () => void;
  private readonly cancelRequested: Promise<void>;
  private consumed = false;
  private terminalSeen = false;

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
    this.cancelRequested = new Promise((resolve) => {
      this.resolveCancelRequested = resolve;
    });
    if (this.signal.aborted) void this.requestCancel('signal', false);
    else this.signal.addEventListener('abort', () => void this.requestCancel('signal'), { once: true });
  }

  /**
   * W07: one cancellation in flight per session. The server's positive abort
   * reply (`true`) is the receipt; the event iterator ends with
   * `cancel.receipt` + `turn.finished interrupted` only once it arrived.
   * W07a: a request that came back unconfirmed (`false`, an error body, a
   * transport failure) is not a receipt, and a later explicit
   * `abort()`/`interrupt()` sends a fresh request instead of replaying the
   * failed one.
   */
  private requestCancel(via: CancelVia, callServer = true): Promise<{ via: CancelVia; acknowledged: boolean }> {
    const retry = this.cancelSettled !== null && !this.cancelSettled.acknowledged && callServer;
    if (!this.cancelRequest || retry) {
      this.cancelSettled = null;
      const request = (async () => {
        if (!callServer) return { via, acknowledged: true };
        if (via === 'interrupt' && this.client.session.interrupt) {
          try {
            const answer = await this.client.session.interrupt({ path: { id: this.externalId }, signal: AbortSignal.timeout(ABORT_TIMEOUT_MS) });
            if (isOpenCodeAbortReceipt(answer)) return { via, acknowledged: true };
          } catch {
            // Fall through to the abort route, whose answer is the receipt.
          }
        }
        return { via, acknowledged: await confirmOpenCodeAbort(this.client, this.externalId) };
      })();
      this.cancelRequest = request;
      void request.then((result) => {
        if (this.cancelRequest === request) this.cancelSettled = result;
      });
      this.resolveCancelRequested();
    }
    return this.cancelRequest;
  }

  private async *cancelEvents(promptSent: boolean): AsyncGenerator<AgentEvent> {
    const result = await (this.cancelRequest ?? this.requestCancel('abort'));
    if (!promptSent) {
      yield { t: 'cancel.receipt', via: result.via, confirmedBy: 'not-started' };
      yield { t: 'turn.finished', turn: 0, reason: 'interrupted' };
      return;
    }
    if (result.acknowledged) {
      yield { t: 'cancel.receipt', via: result.via, confirmedBy: 'server-ack' };
      yield { t: 'turn.finished', turn: 0, reason: 'interrupted' };
      return;
    }
    yield { t: 'error', code: 'cancel_unconfirmed', message: 'OpenCode did not acknowledge the abort request', retryable: false };
    yield { t: 'turn.finished', turn: 0, reason: 'error' };
  }

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of self.stream()) {
          // The server reported the turn over: a later cancel is a no-op.
          if (event.t === 'turn.finished') self.terminalSeen = true;
          yield event;
        }
      },
    };
  }

  private stream(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        if (self.consumed) throw new Error('Runner session events can only be consumed once');
        self.consumed = true;
        yield { t: 'session.started', externalId: self.externalId, model: { id: self.model?.modelID ?? 'opencode' } };
        if (self.cancelRequest) {
          yield* self.cancelEvents(false);
          return;
        }
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
          yield { t: 'turn.finished', turn: 0, reason: 'error' };
          return;
        }
        const usageHighWater = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } };
        const reportedTypes = new Set<string>();
        let malformed = 0;
        const iterator = subscribed.stream[Symbol.asyncIterator]();
        const cancelled = self.cancelRequested.then(() => 'cancel' as const);
        try {
          for (;;) {
            const next = await Promise.race([iterator.next(), cancelled]);
            if (next === 'cancel') {
              yield* self.cancelEvents(true);
              return;
            }
            if (next.done) break;
            const event = normalizeEvent(next.value);
            if (!event) {
              // Reported without content: it could belong to another session.
              malformed += 1;
              if (malformed <= MAX_MALFORMED_DIAGNOSTICS) {
                yield { t: 'diagnostic', code: 'malformed_line', message: 'Ignored a malformed OpenCode event' };
              }
              continue;
            }
            // Connection liveness is explicitly unscoped. Every other event must
            // prove it belongs to this session before decoding or mutating state.
            // Unscoped file.edited/errors and child traffic are not run events.
            const connectionEvent = event.type === 'server.connected' || event.type === 'server.heartbeat';
            if (!connectionEvent && extractSessionId(event) !== self.externalId) continue;
            const decoded = decodeOpenCodeEvent(event, usageHighWater);
            if (!decoded) {
              if (!KNOWN_EVENT_TYPES.has(event.type) && !reportedTypes.has(event.type)) {
                reportedTypes.add(event.type);
                yield { t: 'diagnostic', code: 'unknown_event', message: `Ignored unknown OpenCode event type ${event.type}` };
              }
              continue;
            }
            const events = Array.isArray(decoded) ? decoded : [decoded];
            for (const item of events) {
              yield item;
              if (item.t === 'turn.finished') return;
              if (item.t === 'error') {
                // W07: an error ends the turn; consumers need a terminal event.
                yield { t: 'turn.finished', turn: 0, reason: 'error' };
                return;
              }
            }
          }
          if (self.cancelRequest) {
            yield* self.cancelEvents(true);
            return;
          }
          // W07: a stream that ends without session.idle/error is a failure, never success.
          yield { t: 'error', code: 'eof', message: 'OpenCode event stream ended before the session finished', retryable: false };
          yield { t: 'turn.finished', turn: 0, reason: 'error' };
        } finally {
          // Not awaited: after a cancellation the stream may still be blocked
          // on a read that never resolves.
          void Promise.resolve(iterator.return?.()).catch(() => undefined);
        }
      },
    };
  }

  /** Best-effort graceful stop: resolves either way; the event stream carries the outcome. */
  async interrupt(): Promise<void> {
    if (this.terminalSeen && !this.cancelRequest) return;
    await this.requestCancel('interrupt');
  }

  /**
   * W07a: resolves only on a positive server receipt (OpenCode answered the
   * abort with `true`), or when the server already reported the turn over;
   * rejects otherwise, so a caller that treats a resolved abort as
   * "stopped" is never misled.
   */
  async abort(): Promise<void> {
    if (this.terminalSeen && !this.cancelRequest) return;
    const result = await this.requestCancel('abort');
    if (!result.acknowledged) throw new Error('OpenCode did not confirm the abort request');
  }

  /**
   * Answers through the session route both the v1 and the bundled 1.x
   * servers serve; a client without it is an error (never a silent no-op,
   * which would leave the agent waiting).
   */
  async replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void> {
    const response = decision === 'deny' ? 'reject' : scope === 'session' ? 'always' : 'once';
    if (typeof this.client.postSessionIdPermissionsPermissionId === 'function') {
      const result = await this.client.postSessionIdPermissionsPermissionId({ path: { id: this.externalId, permissionID: id }, body: { response } });
      if (isRecord(result) && result.error) throw new Error(`OpenCode refused the permission reply: ${JSON.stringify(result.error).slice(0, 300)}`);
      return;
    }
    if (this.client.permission?.reply) {
      await this.client.permission.reply({ path: { id }, body: { reply: response } });
      return;
    }
    throw new Error('This OpenCode client cannot answer permission requests');
  }

  async compact(): Promise<void> {
    await this.client.session.compact?.({ path: { id: this.externalId } });
  }
}

export class OpenCodeRunner implements AgentRunner {
  readonly id = 'opencode' as const;
  readonly capabilities = CAPABILITIES;
  readonly features = FEATURES;

  constructor(private readonly resolveClient: (directory: string) => Promise<LooseClient> = defaultClient) {}

  async healthCheck(): Promise<RunnerHealth> {
    // W07: the hard-coded '1.18' version was not measured; report only what
    // is known. Runs start per-attempt sandboxed servers (W09a); this is the
    // management server that holds provider configuration.
    const status = getOpenCodeStatus();
    return {
      ok: status.running,
      detail: status.running
        ? `OpenCode management server running at ${status.serverUrl ?? 'unknown url'}; runs use per-attempt sandboxed servers`
        : 'OpenCode management server is not running',
      auth: { status: 'unknown', detail: 'Provider credentials are configured in OpenCode' },
    };
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
      // W07: continue, never resend an empty prompt or replay the task.
      prompt: input.prompt ?? RESUME_CONTINUATION_PROMPT,
      systemContract: EXECUTION_SYSTEM_CONTRACT,
    });
  }
}

async function defaultClient(directory: string): Promise<LooseClient> {
  try {
    return await getClientForUser('system', directory) as LooseClient;
  } catch (error) {
    // W09a: a sandbox refusal must never degrade into the ambient
    // (unsandboxed) server below.
    if (error instanceof SandboxUnavailableError || error instanceof SandboxStartError) throw error;
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
