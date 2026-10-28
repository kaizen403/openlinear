import type { AgentEvent, TokenUsage } from '@openlinear/execution-core';
import type { NativeFormat } from '../runners/native/commands';
import { graderCanary, type SampleTaskSource } from '../tasks/samples';
import { type FileEffect, type NativeStep, type RecordedTrajectory, RecordedTrajectorySchema, TRAJECTORY_SCHEMA_VERSION } from '../trajectory/types';
import { stableUnit } from '../util/random';

/**
 * Synthetic recordings for the offline smoke suite. They imitate the shape
 * of real runs (read → edit → test → answer, with usage and cost receipts)
 * for each runner protocol, and cover every outcome class. They are authored
 * fixtures, not captured model output, and carry `source: "synthetic"`.
 */

export type BehaviourKind = 'fix' | 'wrong-fix' | 'noop' | 'timeout' | 'refusal' | 'infra' | 'safety' | 'agent-error';

export const BEHAVIOUR_KINDS: readonly BehaviourKind[] = ['fix', 'wrong-fix', 'noop', 'timeout', 'refusal', 'infra', 'safety', 'agent-error'];

interface Plan {
  kind: BehaviourKind;
  task: SampleTaskSource;
  model: string;
  /** Deterministic jitter in [0, 1). */
  jitter: number;
  /** Suffix for session/message ids, so several sessions of one trial never share a usage message id. */
  idSuffix: string;
  /** Fresh input tokens on top of the kind's base (e.g. a longer prompt). */
  extraInputTokens: number;
}

function edits(plan: Plan): Record<string, string> {
  if (plan.kind === 'fix' || plan.kind === 'safety') return plan.task.fixed;
  if (plan.kind === 'wrong-fix' || plan.kind === 'timeout') return plan.task.wrongFix;
  return {};
}

function effectsFor(plan: Plan, afterEvent: number): FileEffect[] {
  const out: FileEffect[] = Object.entries(edits(plan)).map(([path, content]) => ({ afterEvent, path, op: 'write', content }));
  if (plan.kind === 'safety') {
    // The agent copied text it could only have read from the grader assets.
    out.push({ afterEvent, path: 'NOTES.md', op: 'write', content: `Expected output per hidden test: ${graderCanary(plan.task.id)}\n` });
  }
  return out;
}

function tokensFor(plan: Plan): TokenUsage {
  const scale = { fix: 1, safety: 1.1, 'wrong-fix': 1.2, noop: 0.5, timeout: 2.5, refusal: 0.2, infra: 0.3, 'agent-error': 0.6 }[plan.kind];
  const j = 0.8 + plan.jitter * 0.4;
  const round = (n: number) => Math.round(n * scale * j);
  return { input: round(18_000) + plan.extraInputTokens, output: round(2_400), cacheRead: round(64_000), cacheWrite: round(9_000), reasoning: round(900) };
}

/** Cost a runner would report for these tokens (synthetic list price: $3 / $15 / $0.30 / $3.75 per MTok). */
export function reportedCost(tokens: TokenUsage): number {
  return (tokens.input * 3 + tokens.output * 15 + tokens.cacheRead * 0.3 + tokens.cacheWrite * 3.75) / 1_000_000;
}

/** The file a task's fix belongs in. */
export const mainFile = (task: SampleTaskSource) => Object.keys(task.fixed)[0] ?? 'src/index.mjs';
const testFile = (task: SampleTaskSource) => task.verifierCommand[2] ?? 'test/index.test.mjs';

// ------------------------------------------------------------ AgentEvent (adapter replay)

function agentEventsFor(plan: Plan): { events: Array<{ atMs: number; event: AgentEvent }>; effects: FileEffect[]; hangAfterEvent: number | null } {
  const events: Array<{ atMs: number; event: AgentEvent }> = [];
  let t = 0;
  const push = (event: AgentEvent, gapMs = 400) => {
    t += Math.round(gapMs * (0.7 + plan.jitter * 0.6));
    events.push({ atMs: t, event });
    return events.length - 1;
  };
  const tokens = tokensFor(plan);
  const usage: AgentEvent = { t: 'usage', usage: tokens, cost: { usd: reportedCost(tokens), basis: 'opencode message cost (synthetic)' }, messageId: `msg-${plan.task.id}${plan.idSuffix}` };
  push({ t: 'session.started', externalId: `ses-${plan.task.id}${plan.idSuffix}`, model: { provider: 'fake', id: plan.model } }, 150);
  push({ t: 'turn.started', turn: 1 }, 50);
  if (plan.kind === 'infra') {
    push({ t: 'error', code: 'overloaded', message: 'provider returned 529 overloaded', retryable: true }, 900);
    push({ t: 'turn.finished', turn: 1, reason: 'error' }, 10);
    return { events, effects: [], hangAfterEvent: null };
  }
  if (plan.kind === 'refusal') {
    push({ t: 'message.delta', text: 'I can’t help with this request.' }, 700);
    push(usage, 20);
    push({ t: 'error', code: 'refusal', message: 'model declined the task', retryable: false }, 10);
    push({ t: 'turn.finished', turn: 1, reason: 'error' }, 10);
    return { events, effects: [], hangAfterEvent: null };
  }
  push({ t: 'message.delta', text: `Reading ${testFile(plan.task)} to see what fails.` }, 600);
  push({ t: 'tool.started', callId: 'call-read', name: 'read', input: { filePath: testFile(plan.task) } }, 300);
  push({ t: 'tool.finished', callId: 'call-read', name: 'read', ok: true, summary: '(test source)' }, 200);
  if (plan.kind === 'noop') {
    push({ t: 'message.delta', text: 'I could not determine a safe fix.' }, 900);
    push(usage, 20);
    push({ t: 'turn.finished', turn: 1, reason: 'idle' }, 10);
    return { events, effects: [], hangAfterEvent: null };
  }
  if (plan.kind === 'agent-error') {
    push({ t: 'diagnostic', code: 'process_exit', message: 'runtime exited unexpectedly' }, 800);
    push({ t: 'error', code: 'eof', message: 'stream closed before the turn ended', retryable: false }, 10);
    push({ t: 'turn.finished', turn: 1, reason: 'error' }, 10);
    return { events, effects: [], hangAfterEvent: null };
  }
  push({ t: 'tool.started', callId: 'call-edit', name: 'edit', input: { filePath: mainFile(plan.task) } }, 1500);
  const editDone = push({ t: 'tool.finished', callId: 'call-edit', name: 'edit', ok: true }, 300);
  push({ t: 'file.changed', path: mainFile(plan.task), kind: 'edit' }, 5);
  push({ t: 'tool.started', callId: 'call-test', name: 'bash', input: { command: plan.task.verifierCommand.join(' ') } }, 400);
  if (plan.kind === 'timeout') {
    const hang = push({ t: 'tool.output', callId: 'call-test', chunk: 'running…' }, 300);
    return { events, effects: effectsFor(plan, editDone), hangAfterEvent: hang };
  }
  push({ t: 'tool.finished', callId: 'call-test', name: 'bash', ok: plan.kind !== 'wrong-fix' || plan.jitter > 0.5, summary: '# tests finished' }, 900);
  push({ t: 'message.delta', text: 'Updated the implementation; the test passes.' }, 500);
  push(usage, 20);
  push({ t: 'turn.finished', turn: 1, reason: 'idle' }, 10);
  return { events, effects: effectsFor(plan, editDone), hangAfterEvent: null };
}

// ------------------------------------------------------------ native protocols

function nativeFor(plan: Plan, format: NativeFormat, timeScale: number): { steps: NativeStep[]; effects: FileEffect[] } {
  const effects = effectsFor(plan, -1);
  const tokens = tokensFor(plan);
  const sleep = (ms: number): NativeStep => ({ sleepMs: Math.round(ms * timeScale * (0.7 + plan.jitter * 0.6)) });
  const effectSteps = (): NativeStep[] => effects.map((_, i) => ({ effect: i }));
  const steps: NativeStep[] = [];
  if (format === 'claude-stream-json') {
    const session = `sess-${plan.task.id}`;
    const msgUsage = { input_tokens: Math.round(tokens.input / 3), output_tokens: Math.round(tokens.output / 3), cache_read_input_tokens: Math.round(tokens.cacheRead / 3), cache_creation_input_tokens: Math.round(tokens.cacheWrite / 3) };
    const result = (extra: Record<string, unknown>) => ({
      line: {
        type: 'result',
        session_id: session,
        num_turns: 3,
        duration_ms: 4200,
        total_cost_usd: reportedCost(tokens),
        usage: { input_tokens: tokens.input, output_tokens: tokens.output, cache_read_input_tokens: tokens.cacheRead, cache_creation_input_tokens: tokens.cacheWrite },
        modelUsage: { [plan.model]: { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadInputTokens: tokens.cacheRead, cacheCreationInputTokens: tokens.cacheWrite, costUSD: reportedCost(tokens) } },
        ...extra,
      },
    });
    steps.push({ line: { type: 'system', subtype: 'init', session_id: session, model: plan.model, cwd: '.', tools: ['Read', 'Edit', 'Bash'] } }, sleep(300));
    if (plan.kind === 'infra') {
      steps.push(sleep(600), result({ subtype: 'error_during_execution', is_error: true, api_error_status: 529, errors: ['Overloaded'] }));
      return { steps, effects: [] };
    }
    if (plan.kind === 'refusal') {
      steps.push({ line: { type: 'assistant', message: { id: 'msg_1', role: 'assistant', stop_reason: 'refusal', content: [{ type: 'text', text: 'I can’t help with that.' }], usage: msgUsage } } }, sleep(300), result({ subtype: 'success', is_error: false }));
      return { steps, effects: [] };
    }
    steps.push(
      { line: { type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Reading the failing test.' }, { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: testFile(plan.task) } }], usage: msgUsage } } },
      sleep(300),
      { line: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '(test source)' }] } } },
    );
    if (plan.kind === 'noop') {
      steps.push({ line: { type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'I could not find a safe fix.' }], usage: msgUsage } } }, result({ subtype: 'success', is_error: false }));
      return { steps, effects: [] };
    }
    if (plan.kind === 'agent-error') {
      steps.push(sleep(500), { stderr: 'fatal: unexpected runtime error' }, { exit: 1 });
      return { steps, effects: [] };
    }
    steps.push(
      sleep(1200),
      { line: { type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: mainFile(plan.task), old_string: '…', new_string: '…' } }], usage: msgUsage } } },
      ...effectSteps(),
      { line: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'edited' }] } } },
      { line: { type: 'assistant', message: { id: 'msg_3', role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_3', name: 'Bash', input: { command: plan.task.verifierCommand.join(' ') } }], usage: msgUsage } } },
    );
    if (plan.kind === 'timeout') {
      steps.push({ hang: true });
      return { steps, effects };
    }
    steps.push(
      sleep(800),
      { line: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content: '# pass' }] } } },
      { line: { type: 'assistant', message: { id: 'msg_4', role: 'assistant', content: [{ type: 'text', text: 'Fixed; the test passes.' }], usage: msgUsage } } },
      result({ subtype: 'success', is_error: false }),
    );
    return { steps, effects };
  }

  if (format === 'codex-jsonl') {
    const usage = { input_tokens: tokens.input + tokens.cacheRead, cached_input_tokens: tokens.cacheRead, output_tokens: tokens.output, reasoning_output_tokens: tokens.reasoning };
    steps.push({ line: { type: 'thread.started', thread_id: `th-${plan.task.id}` } }, { line: { type: 'turn.started' } }, sleep(300));
    if (plan.kind === 'infra') {
      steps.push(sleep(600), { line: { type: 'turn.failed', error: { message: 'stream error: 503 Service Unavailable' } } }, { exit: 1 });
      return { steps, effects: [] };
    }
    if (plan.kind === 'refusal') {
      steps.push({ line: { type: 'turn.failed', error: { message: 'The model refused the request (content policy).' } } }, { exit: 1 });
      return { steps, effects: [] };
    }
    steps.push(
      { line: { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'Inspecting the failing test.' } } },
      { line: { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: plan.task.verifierCommand.join(' '), status: 'in_progress' } } },
      sleep(500),
      { line: { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: plan.task.verifierCommand.join(' '), aggregated_output: 'not ok 1', exit_code: 1, status: 'completed' } } },
    );
    if (plan.kind === 'noop') {
      steps.push({ line: { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'I could not find a safe fix.' } } }, { line: { type: 'turn.completed', usage } });
      return { steps, effects: [] };
    }
    if (plan.kind === 'agent-error') {
      steps.push(sleep(400), { stderr: 'codex: unexpected EOF' }, { exit: 1 });
      return { steps, effects: [] };
    }
    steps.push(sleep(1200), ...effectSteps(), { line: { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: Object.keys(edits(plan)).map((path) => ({ path, kind: 'update' })), status: 'completed' } } });
    if (plan.kind === 'timeout') {
      steps.push({ line: { type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'node --test', status: 'in_progress' } } }, { hang: true });
      return { steps, effects };
    }
    steps.push(sleep(700), { line: { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'Fixed the implementation.' } } }, { line: { type: 'turn.completed', usage } });
    return { steps, effects };
  }

  // opencode-json
  const session = `ses_${plan.task.id}`;
  let ts = 1_793_000_000_000;
  const ev = (type: string, body: Record<string, unknown>): NativeStep => {
    ts += 250;
    return { line: { type, timestamp: ts, sessionID: session, ...body } };
  };
  const stepFinish = (reason: string, share: number) =>
    ev('step_finish', {
      part: {
        type: 'step-finish',
        reason,
        cost: reportedCost(tokens) * share,
        tokens: { input: Math.round(tokens.input * share), output: Math.round(tokens.output * share), reasoning: Math.round(tokens.reasoning * share), cache: { read: Math.round(tokens.cacheRead * share), write: Math.round(tokens.cacheWrite * share) } },
      },
    });
  steps.push(ev('step_start', { part: { type: 'step-start' } }), sleep(300));
  if (plan.kind === 'infra') {
    steps.push(sleep(600), ev('error', { error: { name: 'APIError', data: { message: 'Overloaded', statusCode: 529 } } }), { exit: 1 });
    return { steps, effects: [] };
  }
  if (plan.kind === 'refusal') {
    steps.push(ev('error', { error: { name: 'APIError', data: { message: 'The model refused to answer (content policy)', statusCode: 400 } } }), { exit: 1 });
    return { steps, effects: [] };
  }
  steps.push(ev('tool_use', { part: { type: 'tool', tool: 'read', callID: 'call_1', state: { status: 'completed', input: { filePath: testFile(plan.task) }, output: '(test source)' } } }));
  if (plan.kind === 'noop') {
    steps.push(stepFinish('tool-calls', 0.5), ev('step_start', { part: { type: 'step-start' } }), ev('text', { part: { type: 'text', text: 'I could not find a safe fix.' } }), stepFinish('stop', 0.5));
    return { steps, effects: [] };
  }
  if (plan.kind === 'agent-error') {
    steps.push(sleep(400), { stderr: 'opencode: server crashed' }, { exit: 1 });
    return { steps, effects: [] };
  }
  steps.push(sleep(1200), ...effectSteps(), ev('tool_use', { part: { type: 'tool', tool: 'edit', callID: 'call_2', state: { status: 'completed', input: { filePath: mainFile(plan.task) }, output: '' } } }));
  if (plan.kind === 'timeout') {
    steps.push({ hang: true });
    return { steps, effects };
  }
  steps.push(
    sleep(700),
    ev('tool_use', { part: { type: 'tool', tool: 'bash', callID: 'call_3', state: { status: 'completed', input: { command: plan.task.verifierCommand.join(' ') }, output: '# pass' } } }),
    stepFinish('tool-calls', 0.7),
    ev('step_start', { part: { type: 'step-start' } }),
    ev('text', { part: { type: 'text', text: 'Fixed; the test passes.' } }),
    stepFinish('stop', 0.3),
  );
  return { steps, effects };
}

export interface RecordingRequest {
  task: SampleTaskSource;
  kind: BehaviourKind;
  runner: string;
  model: string;
  /** null = AgentEvent stream (OpenLinear adapter replay); otherwise a native CLI protocol. */
  format: NativeFormat | null;
  seedLabel: string;
  /** Native protocols only: multiplies recorded sleeps (adapter replays scale in ReplayAgentRunner). Default 1. */
  timeScale?: number;
  /** A later session of the same trial (W21 reviewer arm): keeps its ids distinct. */
  phase?: string;
  /** Extra fresh input tokens (W21: the fake charges for what a longer prompt costs). */
  extraInputTokens?: number;
}

export function synthesizeRecording(request: RecordingRequest): RecordedTrajectory {
  const plan: Plan = { kind: request.kind, task: request.task, model: request.model, jitter: stableUnit(request.seedLabel, 'jitter'), idSuffix: request.phase ? `-${request.phase}` : '', extraInputTokens: request.extraInputTokens ?? 0 };
  const id = `${request.runner}-${request.task.id}-${request.kind}-${request.seedLabel}`;
  if (request.format === null) {
    const { events, effects, hangAfterEvent } = agentEventsFor(plan);
    return RecordedTrajectorySchema.parse({
      schemaVersion: TRAJECTORY_SCHEMA_VERSION,
      id,
      taskId: request.task.id,
      runner: request.runner,
      source: 'synthetic',
      agentEvents: events,
      native: null,
      effects,
      behavior: { startError: null, hangAfterEvent },
      note: `synthetic ${request.kind}`,
    });
  }
  const { steps, effects } = nativeFor(plan, request.format, request.timeScale ?? 1);
  return RecordedTrajectorySchema.parse({
    schemaVersion: TRAJECTORY_SCHEMA_VERSION,
    id,
    taskId: request.task.id,
    runner: request.runner,
    source: 'synthetic',
    agentEvents: [],
    native: { format: request.format, steps },
    effects,
    behavior: { startError: null, hangAfterEvent: null },
    note: `synthetic ${request.kind}`,
  });
}

/**
 * The fake "model behaviour" for a trial: a per-configuration success
 * propensity applied with a stable hash of (configuration, task, repeat,
 * attempt), plus forced slots so every outcome class appears in the smoke.
 */
export function chooseBehaviour(input: {
  configurationId: string;
  taskId: string;
  repeat: number;
  attempt: number;
  propensity: number;
  forced?: ReadonlyMap<string, BehaviourKind>;
}): BehaviourKind {
  const forced = input.forced?.get(`${input.configurationId}/${input.taskId}/${input.repeat}/${input.attempt}`);
  if (forced) return forced;
  const u = stableUnit(input.configurationId, input.taskId, input.repeat, input.attempt, 'behaviour');
  if (u < input.propensity) return 'fix';
  const v = stableUnit(input.configurationId, input.taskId, input.repeat, input.attempt, 'failure');
  if (v < 0.55) return 'wrong-fix';
  if (v < 0.85) return 'noop';
  return 'agent-error';
}
