import type {
  AgentEvent,
  AgentRunner,
  AgentSession,
  ModelDescriptor,
  ResumeInput,
  RunnerCapabilities,
  RunnerFeatures,
  RunnerHealth,
  RunnerId,
  StartInput,
} from '@openlinear/execution-core';
import { type RecordedTrajectory, toAgentEvent } from '../trajectory/types';
import { applyEffect } from './workspace';

/**
 * FAKE mode for the OpenLinear-in-the-loop path: an `AgentRunner` (the
 * execution-core contract every real adapter implements) that replays a
 * recorded trajectory instead of contacting a model. It applies the recorded
 * file effects to the real worktree at the recorded points, honours
 * interrupt/abort/signal with a confirmed `cancel.receipt`, and can simulate
 * start failures and hangs. No network, no inference.
 */

export class RunnerStartError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RunnerStartError';
  }
}

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

const FEATURES: RunnerFeatures = {
  resume: 'none',
  interrupt: 'graceful-ack',
  approvals: 'policy-only',
  models: { discovery: 'none', aliases: [], passthrough: true },
  maxContextTokens: null,
  usage: { cost: 'reported', cacheSplit: true, reasoning: true, semantics: 'snapshot-per-message' },
  isolation: 'sandbox-provider-process',
};

export interface ReplayAgentRunnerOptions {
  id: RunnerId;
  /** Chooses the recording for a start (typically by run id → trial). */
  pick: (input: StartInput) => RecordedTrajectory;
  /** Multiplies recorded event offsets (0 = as fast as possible). Default 0. */
  timeScale?: number;
  version?: string;
}

export class ReplayAgentRunner implements AgentRunner {
  readonly id: RunnerId;
  readonly capabilities = CAPABILITIES;
  readonly features = FEATURES;
  private readonly options: ReplayAgentRunnerOptions;

  constructor(options: ReplayAgentRunnerOptions) {
    this.id = options.id;
    this.options = options;
  }

  async healthCheck(): Promise<RunnerHealth> {
    return { ok: true, detail: 'replay (no model contacted)', version: this.options.version ?? 'replay-1', auth: { status: 'unknown', method: 'none' } };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async start(input: StartInput): Promise<AgentSession> {
    const trajectory = this.options.pick(input);
    if (input.signal.aborted) return new ReplaySession(trajectory, input, this.options.timeScale ?? 0, true);
    const failure = trajectory.behavior.startError;
    if (failure) throw new RunnerStartError(failure.code, failure.message);
    return new ReplaySession(trajectory, input, this.options.timeScale ?? 0, false);
  }

  async resume(_externalSessionId: string, _input: ResumeInput): Promise<AgentSession> {
    throw new RunnerStartError('RESUME_UNSUPPORTED', 'replay sessions cannot be resumed');
  }
}

class ReplaySession implements AgentSession {
  readonly externalId: string;
  private stopVia: 'interrupt' | 'abort' | 'signal' | null = null;
  private wake: (() => void) | null = null;

  constructor(
    private readonly trajectory: RecordedTrajectory,
    private readonly input: StartInput,
    private readonly timeScale: number,
    private readonly preCancelled: boolean,
  ) {
    this.externalId = `replay-${trajectory.id}`;
    input.signal.addEventListener('abort', () => this.stop('signal'), { once: true });
  }

  private stop(via: 'interrupt' | 'abort' | 'signal'): void {
    if (this.stopVia === null) this.stopVia = via;
    this.wake?.();
  }

  async interrupt(): Promise<void> {
    this.stop('interrupt');
  }

  async abort(): Promise<void> {
    this.stop('abort');
  }

  async replyPermission(): Promise<void> {
    // Replay recordings never request permissions (policy-only approvals).
  }

  private wait(ms: number | null): Promise<void> {
    if (this.stopVia !== null) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const done = () => {
        if (timer) clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      this.wake = done;
      if (ms !== null) timer = setTimeout(done, ms);
    });
  }

  get events(): AsyncIterable<AgentEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        const cancelled = (): AgentEvent[] => [
          { t: 'cancel.receipt', via: self.stopVia ?? 'signal', confirmedBy: 'runner-ack' },
          { t: 'turn.finished', turn: 0, reason: 'interrupted' },
        ];
        if (self.preCancelled) {
          yield { t: 'cancel.receipt', via: 'signal', confirmedBy: 'not-started' } satisfies AgentEvent;
          yield { t: 'turn.finished', turn: 0, reason: 'interrupted' } satisfies AgentEvent;
          return;
        }
        for (const effect of self.trajectory.effects.filter((e) => e.afterEvent === -1)) await applyEffect(self.input.worktreePath, effect);
        const started = Date.now();
        const { agentEvents, behavior } = self.trajectory;
        for (const [index, timed] of agentEvents.entries()) {
          const due = started + timed.atMs * self.timeScale;
          const delay = due - Date.now();
          if (delay > 0) await self.wait(delay);
          if (self.stopVia !== null) {
            yield* cancelled();
            return;
          }
          yield toAgentEvent(timed.event);
          for (const effect of self.trajectory.effects.filter((e) => e.afterEvent === index)) {
            await applyEffect(self.input.worktreePath, effect);
          }
          if (behavior.hangAfterEvent === index) {
            await self.wait(null);
            yield* cancelled();
            return;
          }
        }
      },
    };
  }
}
