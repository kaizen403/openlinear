import type { AgentEvent, AgentSession } from '@openlinear/execution-core';
import { processAgentEvent, type EventProcessorState } from '@openlinear/execution-core';
import type { RunJournal } from '../journal/sqlite';

export interface AttachedRun {
  runId: string;
  session: AgentSession;
  state: EventProcessorState;
}

/**
 * One subscribe/event channel per backend session. Events are demuxed by
 * session id and each run's channel is serialized; seq is assigned at journal append.
 */
export class SessionManager {
  private readonly channels = new Map<string, Promise<void>>();
  private readonly attached = new Map<string, AttachedRun>();

  constructor(private readonly journal: RunJournal) {}

  get(runId: string): AttachedRun | undefined {
    return this.attached.get(runId);
  }

  async attach(
    runId: string,
    session: AgentSession,
    onComplete: (ok: boolean, error?: string) => Promise<void>,
  ): Promise<void> {
    const state: EventProcessorState = {
      taskId: runId,
      sessionId: session.externalId,
      promptSent: false,
      cancelled: false,
      status: 'executing',
      backgroundTaskRunning: false,
      backgroundTaskFailure: null,
      completedToolKeys: new Set(),
      toolsExecuted: 0,
      filesChanged: 0,
      suspendWatchdogs: false,
    };
    this.attached.set(runId, { runId, session, state });

    const previous = this.channels.get(runId) ?? Promise.resolve();
    const next = previous.then(() => this.consume(runId, session, state, onComplete));
    this.channels.set(runId, next.catch(() => undefined));
    await next;
  }

  private async consume(
    runId: string,
    session: AgentSession,
    state: EventProcessorState,
    onComplete: (ok: boolean, error?: string) => Promise<void>,
  ): Promise<void> {
    try {
      for await (const event of session.events) {
        this.journal.append(runId, event);
        const actions = processAgentEvent(event, state);
        for (const action of actions) {
          if (action.type === 'setPromptSent') state.promptSent = true;
          if (action.type === 'suspendWatchdog') state.suspendWatchdogs = true;
          if (action.type === 'resumeWatchdog') state.suspendWatchdogs = false;
          if (action.type === 'handleSessionComplete') {
            await onComplete(true);
            return;
          }
          if (action.type === 'failExecution') {
            await onComplete(false, action.message);
            return;
          }
        }
        if (event.t === 'heartbeat') {
          this.journal.heartbeat(runId);
        }
      }
    } catch (err) {
      await onComplete(false, err instanceof Error ? err.message : 'session channel failed');
    } finally {
      this.attached.delete(runId);
    }
  }
}

export type { AgentEvent };
