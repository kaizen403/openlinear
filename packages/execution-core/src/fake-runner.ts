import type {
  AgentEvent,
  AgentRunner,
  AgentSession,
  ModelDescriptor,
  ResumeInput,
  RunnerCapabilities,
  StartInput,
} from './agent';

export interface FakeRunnerScript {
  events: AgentEvent[];
  /** Delay between events in ms (default 0). */
  delayMs?: number;
}

const FAKE_CAPABILITIES: RunnerCapabilities = {
  streamingDeltas: true,
  reasoningDeltas: true,
  permissionReply: true,
  interrupt: true,
  compact: false,
  revert: false,
  fork: false,
  cacheSplitUsage: true,
};

/**
 * Scripted runner for engine tests (batch isolation, watchdogs, resume).
 * Does not talk to a real agent.
 */
export class FakeAgentRunner implements AgentRunner {
  readonly id = 'opencode' as const;
  readonly capabilities = FAKE_CAPABILITIES;
  private readonly scripts = new Map<string, FakeRunnerScript>();
  private readonly sessions = new Map<string, FakeSession>();
  lastStartInput: StartInput | null = null;
  abortCount = 0;
  interruptCount = 0;

  setScript(runId: string, script: FakeRunnerScript): void {
    this.scripts.set(runId, script);
  }

  async healthCheck() {
    return { ok: true, detail: 'fake', version: '0.0.0' };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: 'fake', provider: 'test', name: 'Fake' }];
  }

  async start(input: StartInput): Promise<AgentSession> {
    this.lastStartInput = input;
    const script = this.scripts.get(input.runId) ?? { events: [{ t: 'turn.finished', turn: 1, reason: 'idle' }] };
    const session = new FakeSession(input.runId, script, input.signal, this);
    this.sessions.set(input.runId, session);
    return session;
  }

  async resume(externalSessionId: string, input: ResumeInput): Promise<AgentSession> {
    const existing = this.sessions.get(externalSessionId);
    if (existing) return existing;
    const script = this.scripts.get(externalSessionId) ?? { events: [{ t: 'turn.finished', turn: 1, reason: 'idle' }] };
    const session = new FakeSession(externalSessionId, script, input.signal, this);
    this.sessions.set(externalSessionId, session);
    return session;
  }

  getSession(runId: string): FakeSession | undefined {
    return this.sessions.get(runId);
  }
}

export class FakeSession implements AgentSession {
  readonly externalId: string;
  private readonly script: FakeRunnerScript;
  private readonly signal: AbortSignal;
  private readonly runner: FakeAgentRunner;
  private aborted = false;
  private interrupted = false;
  permissionReplies: Array<{ id: string; decision: 'allow' | 'deny'; scope?: string }> = [];

  constructor(externalId: string, script: FakeRunnerScript, signal: AbortSignal, runner: FakeAgentRunner) {
    this.externalId = externalId;
    this.script = script;
    this.signal = signal;
    this.runner = runner;
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.runner.interruptCount += 1;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.runner.abortCount += 1;
  }

  async replyPermission(id: string, decision: 'allow' | 'deny', scope?: 'once' | 'session'): Promise<void> {
    this.permissionReplies.push({ id, decision, scope });
  }

  get events(): AsyncIterable<AgentEvent> {
    const script = this.script;
    const signal = this.signal;
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        yield { t: 'session.started', externalId: self.externalId, model: { id: 'fake' } } satisfies AgentEvent;
        for (const event of script.events) {
          if (self.aborted || signal.aborted) {
            yield { t: 'turn.finished', turn: 0, reason: 'interrupted' } satisfies AgentEvent;
            return;
          }
          if (script.delayMs && script.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, script.delayMs));
          }
          if (self.interrupted) {
            yield { t: 'turn.finished', turn: 0, reason: 'interrupted' } satisfies AgentEvent;
            return;
          }
          yield event;
        }
      },
    };
  }
}
