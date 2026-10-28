import type { AgentEvent } from '@openlinear/execution-core';
import type { UsageRecord } from '../usage/cost';
import type { TimedEvent } from './types';

/**
 * Export to ATIF (Agent Trajectory Interchange Format) v1.7, the trajectory
 * format Harbor stores and Terminal-Bench requires for passing trials.
 * Source: harbor-framework/harbor `rfcs/0001-trajectory-format.md` (read
 * 2026-10-26; RFC changelog lists v1.8, Harbor docs name v1.7 current).
 *
 * Runner event streams do not mark LLM-call boundaries, so agent steps are
 * reconstructed (a new step starts when the agent speaks again after tool
 * results) and token/cost metrics are reported only in `final_metrics`.
 * ATIF `prompt_tokens` include cached tokens; disjoint (Anthropic-style)
 * usage is converted accordingly, with cache writes in `extra`.
 */

export const ATIF_VERSION = 'ATIF-v1.7';

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: 'system' | 'user' | 'agent';
  message: string;
  model_name?: string;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: { results: Array<{ source_call_id?: string; content?: string }> };
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: typeof ATIF_VERSION;
  session_id?: string;
  trajectory_id: string;
  agent: { name: string; version: string; model_name?: string; extra?: Record<string, unknown> };
  steps: AtifStep[];
  notes?: string;
  final_metrics?: {
    total_prompt_tokens?: number;
    total_completion_tokens?: number;
    total_cached_tokens?: number;
    total_cost_usd?: number;
    total_steps?: number;
    extra?: Record<string, unknown>;
  };
  extra?: Record<string, unknown>;
}

export interface AtifInput {
  trajectoryId: string;
  agentName: string;
  agentVersion: string;
  modelName: string | null;
  startedAt: string;
  systemPrompt: string | null;
  userPrompt: string;
  events: readonly TimedEvent[];
  usage: UsageRecord;
  extra?: Record<string, unknown>;
}

function argumentsObject(input: unknown): Record<string, unknown> {
  if (typeof input === 'object' && input !== null && !Array.isArray(input)) return input as Record<string, unknown>;
  return input === undefined || input === null ? {} : { input };
}

export function toAtif(input: AtifInput): AtifTrajectory {
  const base = Date.parse(input.startedAt);
  const at = (ms: number) => (Number.isFinite(base) ? new Date(base + ms).toISOString() : undefined);
  const steps: AtifStep[] = [];
  const push = (step: Omit<AtifStep, 'step_id'>) => {
    const full: AtifStep = { step_id: steps.length + 1, ...step };
    steps.push(full);
    return full;
  };
  if (input.systemPrompt) push({ source: 'system', message: input.systemPrompt, timestamp: at(0) });
  push({ source: 'user', message: input.userPrompt, timestamp: at(0) });

  // The open agent step; a new one starts when the agent acts again after tool results arrived.
  const state: { current: AtifStep | null; sawResults: boolean } = { current: null, sawResults: false };
  const agentStep = (ms: number): AtifStep => {
    if (state.current === null || state.sawResults) {
      state.current = push({ source: 'agent', message: '', timestamp: at(ms), ...(input.modelName ? { model_name: input.modelName } : {}) });
      state.sawResults = false;
    }
    return state.current;
  };
  let sessionId: string | undefined;
  const diagnostics: string[] = [];
  for (const { atMs, event } of input.events) {
    const e: AgentEvent = event;
    switch (e.t) {
      case 'session.started':
        sessionId = e.externalId;
        break;
      case 'message.delta': {
        const step = agentStep(atMs);
        step.message += e.text;
        break;
      }
      case 'reasoning.delta': {
        const step = agentStep(atMs);
        step.reasoning_content = (step.reasoning_content ?? '') + e.text;
        break;
      }
      case 'tool.started': {
        const step = agentStep(atMs);
        step.tool_calls = [...(step.tool_calls ?? []), { tool_call_id: e.callId, function_name: e.name, arguments: argumentsObject(e.input) }];
        break;
      }
      case 'tool.finished': {
        const owner = [...steps].reverse().find((s) => s.tool_calls?.some((call) => call.tool_call_id === e.callId));
        const step = owner ?? agentStep(atMs);
        step.observation = { results: [...(step.observation?.results ?? []), { source_call_id: e.callId, content: `${e.ok ? '' : '[error] '}${e.summary ?? ''}` }] };
        if (step === state.current) state.sawResults = true;
        break;
      }
      case 'error':
      case 'diagnostic':
        diagnostics.push(`${e.t}:${e.code}`);
        break;
      default:
        break;
    }
  }

  const tokens = input.usage.tokens;
  let finalMetrics: AtifTrajectory['final_metrics'] = { total_steps: steps.length };
  if (tokens) {
    const disjoint = input.usage.tokenSemantics === 'cache-disjoint';
    finalMetrics = {
      ...finalMetrics,
      total_prompt_tokens: disjoint ? tokens.input + tokens.cacheRead + tokens.cacheWrite : tokens.input,
      total_completion_tokens: tokens.output,
      total_cached_tokens: tokens.cacheRead,
      extra: { cache_creation_input_tokens: tokens.cacheWrite, reasoning_tokens: tokens.reasoning, token_basis: input.usage.tokenBasis, token_semantics: input.usage.tokenSemantics },
    };
  }
  if (input.usage.costUsd !== null) {
    finalMetrics = { ...finalMetrics, total_cost_usd: input.usage.costUsd, extra: { ...(finalMetrics.extra ?? {}), cost_basis: input.usage.costBasis, cost_source: input.usage.costSource } };
  }
  return {
    schema_version: ATIF_VERSION,
    ...(sessionId ? { session_id: sessionId } : {}),
    trajectory_id: input.trajectoryId,
    agent: { name: input.agentName, version: input.agentVersion, ...(input.modelName ? { model_name: input.modelName } : {}) },
    steps,
    notes: `Reconstructed by @openlinear/evals from runner events; per-step LLM metrics are unavailable, totals are in final_metrics.${diagnostics.length ? ` Runner diagnostics: ${diagnostics.join(', ')}.` : ''}`,
    final_metrics: finalMetrics,
    ...(input.extra ? { extra: input.extra } : {}),
  };
}

/** Structural checks from the RFC: sequential step ids, required fields, tool-call/observation correlation. */
export function validateAtif(trajectory: AtifTrajectory): string[] {
  const problems: string[] = [];
  if (trajectory.schema_version !== ATIF_VERSION) problems.push('schema_version');
  if (!trajectory.agent.name || !trajectory.agent.version) problems.push('agent.name/version required');
  const callIds = new Set<string>();
  trajectory.steps.forEach((step, index) => {
    if (step.step_id !== index + 1) problems.push(`step ${index}: step_id ${step.step_id} is not sequential from 1`);
    if (typeof step.message !== 'string') problems.push(`step ${step.step_id}: message required`);
    if (step.source !== 'agent' && (step.tool_calls || step.reasoning_content || step.model_name)) problems.push(`step ${step.step_id}: agent-only fields on a ${step.source} step`);
    for (const call of step.tool_calls ?? []) {
      if (callIds.has(call.tool_call_id)) problems.push(`duplicate tool_call_id ${call.tool_call_id}`);
      callIds.add(call.tool_call_id);
    }
  });
  for (const step of trajectory.steps) {
    for (const result of step.observation?.results ?? []) {
      if (result.source_call_id && !callIds.has(result.source_call_id)) problems.push(`observation for unknown tool_call_id ${result.source_call_id}`);
    }
  }
  return problems;
}
