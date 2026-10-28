import type { RunEventEnvelope, RunState } from '@openlinear/execution-core';

/**
 * W15: where a run spent its time, from its own journal (pure).
 *
 * Every state change is a journaled `run.state` event with its time, so the
 * time in each state is the gap to the next change (the last state runs to
 * the finish, or to `now` while the run is live). States are grouped into
 * the phases people recognise; setup (W16a) is the part of preparing between
 * each setup step's start and end records, and approval wait (FE-04) the part
 * of the agent phase spent in `awaiting_approval`.
 */

export interface RunPhaseTimings {
  /** Waiting for a slot. */
  queuedMs: number;
  /** Checkout, sealing checks, setup, repository context (all of `preparing`). */
  preparingMs: number;
  /** Of preparing: the project's setup steps. */
  setupMs: number;
  /** The agent working (running, awaiting approval, compacting). */
  agentMs: number;
  /** Of agent: waiting for a person's approval. */
  approvalWaitMs: number;
  /** Checks in a pristine checkout. */
  verifyingMs: number;
  /** Commit, push, pull request. */
  finishingMs: number;
  /** Created → finished (or → now while live). */
  totalMs: number;
  /** The run has not finished: the last phase is still counting. */
  live: boolean;
}

type Phase = 'queuedMs' | 'preparingMs' | 'agentMs' | 'verifyingMs' | 'finishingMs';

function phaseOf(state: RunState | string): Phase | null {
  switch (state) {
    case 'queued': return 'queuedMs';
    case 'preparing': return 'preparingMs';
    case 'running':
    case 'awaiting_approval':
    case 'compacting': return 'agentMs';
    case 'verifying': return 'verifyingMs';
    case 'finishing': return 'finishingMs';
    default: return null;
  }
}

export function runPhaseTimings(input: {
  events: ReadonlyArray<Pick<RunEventEnvelope, 'kind' | 'at' | 'payload'>>;
  createdAt: number;
  finishedAt: number | null;
  /** The end of a live run's last phase. */
  now: number;
  /** The run's current state: where a run with no state change yet is (default queued). */
  currentState?: RunState | string;
}): RunPhaseTimings {
  const timings: RunPhaseTimings = { queuedMs: 0, preparingMs: 0, setupMs: 0, agentMs: 0, approvalWaitMs: 0, verifyingMs: 0, finishingMs: 0, totalMs: 0, live: input.finishedAt === null };
  const end = input.finishedAt ?? input.now;
  // Journal order (the events arrive by sequence), not wall-clock order.
  const changes = input.events
    .filter((event) => event.kind === 'run.state' && typeof event.payload.to === 'string')
    .map((event) => ({ at: event.at, from: typeof event.payload.from === 'string' ? event.payload.from : null, to: String(event.payload.to) }));
  let state: string = changes[0]?.from ?? input.currentState ?? 'queued';
  let since = input.createdAt;
  const credit = (until: number) => {
    const ms = Math.max(0, until - since);
    const phase = phaseOf(state);
    if (phase) timings[phase] += ms;
    if (state === 'awaiting_approval') timings.approvalWaitMs += ms;
  };
  for (const change of changes) {
    credit(Math.min(change.at, end));
    state = change.to;
    since = Math.max(since, Math.min(change.at, end));
  }
  credit(end);

  // Setup: each step's start → end record (an unfinished step counts to the end).
  const started = new Map<number, number>();
  for (const event of input.events) {
    const record = event.kind === 'progress' ? event.payload.setupRecord : undefined;
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const phase = (record as Record<string, unknown>).phase;
    const index = (record as Record<string, unknown>).index;
    if (typeof index !== 'number') continue;
    if (phase === 'start') started.set(index, event.at);
    if (phase === 'end') {
      const from = started.get(index);
      if (from !== undefined) timings.setupMs += Math.max(0, event.at - from);
      started.delete(index);
    }
  }
  for (const from of started.values()) timings.setupMs += Math.max(0, end - from);
  timings.setupMs = Math.min(timings.setupMs, timings.preparingMs);
  timings.totalMs = Math.max(0, end - input.createdAt);
  return timings;
}
