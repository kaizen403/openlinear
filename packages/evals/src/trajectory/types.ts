import type { AgentEvent } from '@openlinear/execution-core';
import { z } from 'zod';

/**
 * Trajectory format shared by every harness runner. A real run writes one;
 * FAKE mode replays one. Events use the execution-core `AgentEvent`
 * vocabulary so OpenLinear-in-the-loop and native baselines are recorded
 * identically; native runs additionally keep their raw stdout lines.
 */

export const TRAJECTORY_SCHEMA_VERSION = 'openlinear.eval.trajectory/v1' as const;

const TokenUsageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  reasoning: z.number().nonnegative(),
});

const ModelRefSchema = z.object({ provider: z.string().optional(), id: z.string() });

export const AgentEventSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('session.started'), externalId: z.string(), model: ModelRefSchema }),
  z.object({ t: z.literal('turn.started'), turn: z.number() }),
  z.object({ t: z.literal('message.delta'), text: z.string() }),
  z.object({ t: z.literal('reasoning.delta'), text: z.string() }),
  z.object({ t: z.literal('tool.started'), callId: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ t: z.literal('tool.output'), callId: z.string(), chunk: z.string(), cumulative: z.boolean().optional() }),
  z.object({ t: z.literal('tool.finished'), callId: z.string(), name: z.string(), ok: z.boolean(), summary: z.string().optional() }),
  z.object({ t: z.literal('file.changed'), path: z.string(), kind: z.enum(['edit', 'create', 'delete']) }),
  z.object({ t: z.literal('permission.requested'), id: z.string(), tool: z.string(), detail: z.string() }),
  z.object({ t: z.literal('compaction'), phase: z.enum(['start', 'end']), before: z.number().optional(), after: z.number().optional() }),
  z.object({
    t: z.literal('usage'),
    usage: TokenUsageSchema,
    cost: z.object({ usd: z.number(), basis: z.string().optional() }).optional(),
    messageId: z.string().optional(),
  }),
  z.object({ t: z.literal('turn.finished'), turn: z.number(), reason: z.enum(['idle', 'max_turns', 'error', 'interrupted']) }),
  z.object({ t: z.literal('heartbeat') }),
  z.object({ t: z.literal('error'), code: z.string(), message: z.string(), retryable: z.boolean(), retryAfterMs: z.number().optional() }),
  z.object({ t: z.literal('diagnostic'), code: z.string(), message: z.string(), detail: z.string().optional() }),
  z.object({
    t: z.literal('cancel.receipt'),
    via: z.enum(['interrupt', 'abort', 'signal']),
    confirmedBy: z.enum(['runner-ack', 'server-ack', 'process-exit', 'not-started']),
    exitCode: z.number().nullable().optional(),
    exitSignal: z.string().nullable().optional(),
  }),
]);

export type SchemaEvent = z.infer<typeof AgentEventSchema>;

/**
 * Zod infers `input?: unknown` for `tool.started`; the contract has a
 * required (possibly undefined) `input`. This is the only difference.
 */
export function toAgentEvent(event: SchemaEvent): AgentEvent {
  if (event.t === 'tool.started') return { ...event, input: event.input };
  return event;
}

export const FileEffectSchema = z.object({
  /** Applied after the event at this index has been emitted (-1 = before the first event). */
  afterEvent: z.number().int().min(-1),
  path: z
    .string()
    .min(1)
    .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.split('/').includes('.git'), 'effects stay inside the worktree'),
  op: z.enum(['write', 'delete']),
  content: z.string().optional(),
});

export const NativeStepSchema = z.union([
  z.object({ line: z.unknown() }).strict(),
  z.object({ sleepMs: z.number().int().nonnegative() }).strict(),
  z.object({ stderr: z.string() }).strict(),
  z.object({ effect: z.number().int().nonnegative() }).strict(),
  z.object({ hang: z.literal(true) }).strict(),
  z.object({ exit: z.number().int() }).strict(),
]);

export const RecordedTrajectorySchema = z
  .object({
    schemaVersion: z.literal(TRAJECTORY_SCHEMA_VERSION),
    id: z.string().min(1),
    taskId: z.string().min(1),
    runner: z.string().min(1),
    /** `synthetic`: authored for offline tests. `recorded`: captured from a real run. */
    source: z.enum(['synthetic', 'recorded']),
    /** For OpenLinear adapter replay: the runner's AgentEvent stream with timing. */
    agentEvents: z.array(z.object({ atMs: z.number().nonnegative(), event: AgentEventSchema })).default([]),
    /** For native CLI replay: the raw stdout protocol the real CLI would print. */
    native: z
      .object({
        format: z.enum(['claude-stream-json', 'codex-jsonl', 'opencode-json']),
        steps: z.array(NativeStepSchema),
      })
      .nullable()
      .default(null),
    /** Worktree edits the run made (final file contents). */
    effects: z.array(FileEffectSchema).default([]),
    behavior: z
      .object({
        /** `start()` throws with this code (e.g. SANDBOX_UNAVAILABLE, RUNNER_UNAVAILABLE). */
        startError: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
        /** Stop emitting after this event index and wait until cancelled (watchdog test). */
        hangAfterEvent: z.number().int().nullable().default(null),
      })
      .default({}),
    note: z.string().default(''),
  })
  .strict();

export type RecordedTrajectory = z.infer<typeof RecordedTrajectorySchema>;
export type RecordedTrajectoryInput = z.input<typeof RecordedTrajectorySchema>;
export type FileEffect = z.infer<typeof FileEffectSchema>;
export type NativeStep = z.infer<typeof NativeStepSchema>;

/** An event as observed by the harness, with its offset from the agent start. */
export interface TimedEvent {
  atMs: number;
  event: AgentEvent;
}

export function parseTrajectory(input: unknown): RecordedTrajectory {
  return RecordedTrajectorySchema.parse(input);
}
