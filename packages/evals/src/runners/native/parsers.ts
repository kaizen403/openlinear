import type { AgentEvent, TokenUsage } from '@openlinear/execution-core';
import type { Termination } from '../../grading/outcome';
import type { RawUsage } from '../../usage/cost';
import { terminationForErrorCode } from '../classify';
import type { NativeFormat } from './commands';

/**
 * Parsers for the native CLIs' headless stdout protocols. Each turns raw
 * lines into execution-core `AgentEvent`s (so native and OpenLinear
 * trajectories share one vocabulary) and, at exit, a termination class plus
 * usage with its basis. Unknown or malformed lines become `diagnostic`
 * events, never failures.
 */

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: string | null;
}

export interface ParseSummary {
  termination: Termination;
  detail: string;
  usage: RawUsage;
  observedModel: string | null;
}

export interface NativeParser {
  push(line: string): AgentEvent[];
  finish(exit: ExitInfo): ParseSummary;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function maybeNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function rec(value: unknown): Json {
  return isRecord(value) ? value : {};
}
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseLine(line: string): { value: Json } | { error: AgentEvent } {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) return { error: { t: 'diagnostic', code: 'malformed_line', message: 'line is not a JSON object' } };
    return { value };
  } catch {
    return { error: { t: 'diagnostic', code: 'malformed_line', message: 'unparseable stdout line' } };
  }
}

function exitFallback(exit: ExitInfo, what: string): { termination: Termination; detail: string } {
  if (exit.timedOut) return { termination: 'timeout', detail: 'wall-clock budget' };
  if (exit.cancelled) return { termination: 'cancelled', detail: 'harness cancelled the trial' };
  if (exit.spawnError) return { termination: 'infra', detail: `spawn failed: ${exit.spawnError}` };
  return { termination: 'agent-error', detail: `${what} (exit ${exit.code ?? exit.signal})` };
}

/** Provider error text → runner error code used by `terminationForErrorCode`. */
export function codeForProviderError(status: number | null, message: string): string {
  const text = message.toLowerCase();
  if (status === 429 || /rate.?limit|too many requests/.test(text)) return 'rate_limit';
  if (status === 529 || /overloaded/.test(text)) return 'overloaded';
  if ((status !== null && status >= 500) || /internal server error|service unavailable|bad gateway/.test(text)) return 'server_error';
  if (status === 401 || status === 403 || /unauthori[sz]ed|authentication|invalid api key|forbidden/.test(text)) return 'auth';
  if (/context (window|length)|prompt is too long|too many tokens/.test(text)) return 'context_overflow';
  if (/refus|content policy|safety/.test(text)) return 'refusal';
  return 'provider_error';
}

// ---------------------------------------------------------------- Claude Code

function claudeParser(): NativeParser {
  let model: string | null = null;
  let result: Json | null = null;
  let refused = false;
  const perMessage = new Map<string, TokenUsage>();
  const tools = new Map<string, { name: string; input: Json }>();

  const usageFrom = (u: Json): TokenUsage => ({
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    reasoning: 0,
  });

  return {
    push(line) {
      const parsed = parseLine(line);
      if ('error' in parsed) return [parsed.error];
      const msg = parsed.value;
      const type = str(msg.type);
      const out: AgentEvent[] = [];
      if (type === 'system' && str(msg.subtype) === 'init') {
        model = str(msg.model);
        out.push({ t: 'session.started', externalId: str(msg.session_id) ?? 'unknown', model: { provider: 'anthropic', id: model ?? 'unknown' } });
        out.push({ t: 'turn.started', turn: 1 });
      } else if (type === 'assistant') {
        const message = rec(msg.message);
        const id = str(message.id);
        if (id && isRecord(message.usage)) perMessage.set(id, usageFrom(message.usage));
        if (str(message.stop_reason) === 'refusal') refused = true;
        for (const block of arr(message.content)) {
          const b = rec(block);
          const blockType = str(b.type);
          if (blockType === 'text' && str(b.text)) out.push({ t: 'message.delta', text: str(b.text) ?? '' });
          else if (blockType === 'thinking' && str(b.thinking)) out.push({ t: 'reasoning.delta', text: str(b.thinking) ?? '' });
          else if (blockType === 'tool_use') {
            const callId = str(b.id) ?? `tool-${tools.size}`;
            const name = str(b.name) ?? 'unknown';
            tools.set(callId, { name, input: rec(b.input) });
            out.push({ t: 'tool.started', callId, name, input: b.input ?? null });
          }
        }
      } else if (type === 'user') {
        for (const block of arr(rec(msg.message).content)) {
          const b = rec(block);
          if (str(b.type) !== 'tool_result') continue;
          const callId = str(b.tool_use_id) ?? 'unknown';
          const tool = tools.get(callId);
          const ok = b.is_error !== true;
          const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
          out.push({ t: 'tool.finished', callId, name: tool?.name ?? 'unknown', ok, summary: content.slice(0, 8192) });
          const path = str(tool?.input.file_path);
          if (ok && path && tool && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) {
            out.push({ t: 'file.changed', path, kind: tool.name === 'Write' ? 'create' : 'edit' });
          }
        }
      } else if (type === 'result') {
        result = msg;
        out.push({ t: 'turn.finished', turn: num(msg.num_turns) || 1, reason: msg.is_error === true ? (str(msg.subtype) === 'error_max_turns' ? 'max_turns' : 'error') : 'idle' });
      } else if (type === 'stream_event' || type === 'rate_limit_event' || type === 'keep_alive') {
        // Partial deltas / liveness; complete blocks arrive in `assistant` messages.
      } else if (type === 'system') {
        out.push({ t: 'diagnostic', code: `system_${str(msg.subtype) ?? 'unknown'}`, message: 'system message' });
      } else {
        out.push({ t: 'diagnostic', code: 'unknown_event', message: `unknown type ${type ?? '(none)'}` });
      }
      return out;
    },
    finish(exit) {
      let tokens: TokenUsage | null = null;
      let cost: number | null = null;
      if (result) {
        const modelUsage = rec(result.modelUsage);
        const models = Object.values(modelUsage).filter(isRecord);
        if (models.length > 0) {
          tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
          for (const m of models) {
            tokens.input += num(m.inputTokens);
            tokens.output += num(m.outputTokens);
            tokens.cacheRead += num(m.cacheReadInputTokens);
            tokens.cacheWrite += num(m.cacheCreationInputTokens);
          }
        } else if (isRecord(result.usage)) {
          tokens = usageFrom(result.usage);
        }
        cost = maybeNum(result.total_cost_usd);
      }
      if (perMessage.size > 0) {
        // Per-message usage is a floor (subagent/internal calls are only in the result totals).
        const floor: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
        for (const u of perMessage.values()) {
          floor.input += u.input;
          floor.output += u.output;
          floor.cacheRead += u.cacheRead;
          floor.cacheWrite += u.cacheWrite;
        }
        if (!tokens || tokens.input + tokens.output < floor.input + floor.output) tokens = floor;
      }
      const usage: RawUsage = {
        tokens,
        tokenBasis: tokens ? 'provider-reported' : 'unknown',
        semantics: tokens ? 'cache-disjoint' : 'unknown',
        reportedCostUsd: cost,
        reportedCostBasis: cost !== null ? 'runner-reported' : null,
        reportedCostSource: cost !== null ? 'claude-code result.total_cost_usd (client-side list-price estimate)' : null,
      };
      if (exit.timedOut || exit.cancelled || exit.spawnError || !result) {
        const fallback = exitFallback(exit, 'stream ended without a result');
        return { ...fallback, usage, observedModel: model };
      }
      const r = result;
      if (r.is_error !== true) return { termination: refused ? 'refused' : 'completed', detail: refused ? 'stop_reason refusal' : (str(r.subtype) ?? 'success'), usage, observedModel: model };
      const subtype = str(r.subtype) ?? 'error';
      if (subtype === 'error_max_turns' || str(r.terminal_reason) === 'max_turns') return { termination: 'budget', detail: 'max_turns', usage, observedModel: model };
      if (refused) return { termination: 'refused', detail: 'stop_reason refusal', usage, observedModel: model };
      const errorText = [str(r.result), ...arr(r.errors).map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))].filter(Boolean).join(' ');
      const status = maybeNum(r.api_error_status);
      const code = /budget/i.test(errorText) || subtype === 'error_max_budget_usd' ? 'budget_exhausted' : codeForProviderError(status, errorText);
      return { termination: terminationForErrorCode(code), detail: `${subtype}: ${code}`, usage, observedModel: model };
    },
  };
}

// ---------------------------------------------------------------------- Codex

function codexParser(): NativeParser {
  let turns = 0;
  let completed = false;
  let failure: string | null = null;
  const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let sawUsage = false;

  return {
    push(line) {
      const parsed = parseLine(line);
      if ('error' in parsed) return [parsed.error];
      const msg = parsed.value;
      const type = str(msg.type);
      const out: AgentEvent[] = [];
      if (type === 'thread.started') {
        out.push({ t: 'session.started', externalId: str(msg.thread_id) ?? 'unknown', model: { provider: 'openai', id: 'unreported' } });
      } else if (type === 'turn.started') {
        turns += 1;
        out.push({ t: 'turn.started', turn: turns });
      } else if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
        const item = rec(msg.item);
        const itemType = str(item.type);
        const id = str(item.id) ?? `item-${turns}`;
        if (itemType === 'command_execution') {
          if (type === 'item.started') out.push({ t: 'tool.started', callId: id, name: 'bash', input: { command: item.command ?? null } });
          if (type === 'item.completed') {
            out.push({ t: 'tool.finished', callId: id, name: 'bash', ok: str(item.status) === 'completed' && num(item.exit_code) === 0, summary: (str(item.aggregated_output) ?? '').slice(0, 8192) });
          }
        } else if (type === 'item.completed' && itemType === 'agent_message') {
          out.push({ t: 'message.delta', text: str(item.text) ?? '' });
        } else if (type === 'item.completed' && itemType === 'reasoning') {
          out.push({ t: 'reasoning.delta', text: str(item.text) ?? '' });
        } else if (type === 'item.completed' && itemType === 'file_change') {
          const ok = str(item.status) === 'completed';
          out.push({ t: 'tool.started', callId: id, name: 'apply_patch', input: { changes: item.changes ?? [] } });
          out.push({ t: 'tool.finished', callId: id, name: 'apply_patch', ok });
          if (ok) {
            for (const change of arr(item.changes)) {
              const c = rec(change);
              const path = str(c.path);
              const kind = str(c.kind);
              if (path) out.push({ t: 'file.changed', path, kind: kind === 'add' ? 'create' : kind === 'delete' ? 'delete' : 'edit' });
            }
          }
        } else if (type === 'item.completed' && itemType === 'mcp_tool_call') {
          const name = `${str(item.server) ?? 'mcp'}.${str(item.tool) ?? 'tool'}`;
          out.push({ t: 'tool.started', callId: id, name, input: item.arguments ?? null });
          out.push({ t: 'tool.finished', callId: id, name, ok: str(item.status) === 'completed' });
        } else if (type === 'item.completed' && itemType === 'error') {
          out.push({ t: 'diagnostic', code: 'codex_item_error', message: str(item.message) ?? 'error item' });
        }
      } else if (type === 'turn.completed') {
        const u = rec(msg.usage);
        sawUsage = true;
        const delta: TokenUsage = {
          input: num(u.input_tokens),
          output: num(u.output_tokens),
          cacheRead: num(u.cached_input_tokens),
          cacheWrite: 0,
          reasoning: num(u.reasoning_output_tokens),
        };
        totals.input += delta.input;
        totals.output += delta.output;
        totals.cacheRead += delta.cacheRead;
        totals.reasoning += delta.reasoning;
        completed = true;
        out.push({ t: 'usage', usage: delta });
        out.push({ t: 'turn.finished', turn: turns, reason: 'idle' });
      } else if (type === 'turn.failed' || type === 'error') {
        failure = str(rec(msg.error).message) ?? str(msg.message) ?? 'codex error';
        out.push({ t: 'error', code: 'codex', message: failure, retryable: false });
        if (type === 'turn.failed') out.push({ t: 'turn.finished', turn: turns, reason: 'error' });
      } else {
        out.push({ t: 'diagnostic', code: 'unknown_event', message: `unknown type ${type ?? '(none)'}` });
      }
      return out;
    },
    finish(exit) {
      const usage: RawUsage = {
        tokens: sawUsage ? { ...totals } : null,
        tokenBasis: sawUsage ? 'provider-reported' : 'unknown',
        semantics: sawUsage ? 'cache-in-input' : 'unknown',
        reportedCostUsd: null,
        reportedCostBasis: null,
        reportedCostSource: null,
      };
      if (exit.timedOut || exit.cancelled || exit.spawnError) return { ...exitFallback(exit, ''), usage, observedModel: null };
      if (failure !== null) {
        const code = codeForProviderError(null, failure);
        return { termination: terminationForErrorCode(code), detail: `${code}: ${failure.slice(0, 200)}`, usage, observedModel: null };
      }
      if (completed && exit.code === 0) return { termination: 'completed', detail: 'turn.completed', usage, observedModel: null };
      return { ...exitFallback(exit, 'stream closed before the turn ended'), usage, observedModel: null };
    },
  };
}

// ------------------------------------------------------------------- OpenCode

function opencodeParser(): NativeParser {
  let session: string | null = null;
  let steps = 0;
  let error: { name: string; message: string; status: number | null } | null = null;
  let sawStepFinish = false;
  let lastReason: string | null = null;
  let cost = 0;
  let sawCost = false;
  const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

  return {
    push(line) {
      const parsed = parseLine(line);
      if ('error' in parsed) return [parsed.error];
      const msg = parsed.value;
      const type = str(msg.type);
      const part = rec(msg.part);
      const out: AgentEvent[] = [];
      if (session === null && str(msg.sessionID)) {
        session = str(msg.sessionID);
        out.push({ t: 'session.started', externalId: session ?? 'unknown', model: { id: 'unreported' } });
      }
      if (type === 'step_start') {
        steps += 1;
        out.push({ t: 'turn.started', turn: steps });
      } else if (type === 'tool_use') {
        const state = rec(part.state);
        const callId = str(part.callID) ?? str(part.id) ?? `tool-${steps}`;
        const name = str(part.tool) ?? 'unknown';
        const ok = str(state.status) === 'completed';
        out.push({ t: 'tool.started', callId, name, input: state.input ?? null });
        out.push({ t: 'tool.finished', callId, name, ok, summary: (str(state.output) ?? str(state.error) ?? '').slice(0, 8192) });
        const filePath = str(rec(state.input).filePath);
        if (ok && filePath && ['edit', 'write', 'patch'].includes(name)) out.push({ t: 'file.changed', path: filePath, kind: name === 'write' ? 'create' : 'edit' });
      } else if (type === 'text') {
        out.push({ t: 'message.delta', text: str(part.text) ?? '' });
      } else if (type === 'reasoning') {
        out.push({ t: 'reasoning.delta', text: str(part.text) ?? '' });
      } else if (type === 'step_finish') {
        sawStepFinish = true;
        lastReason = str(part.reason);
        const tokens = rec(part.tokens);
        const cache = rec(tokens.cache);
        const delta: TokenUsage = { input: num(tokens.input), output: num(tokens.output), cacheRead: num(cache.read), cacheWrite: num(cache.write), reasoning: num(tokens.reasoning) };
        totals.input += delta.input;
        totals.output += delta.output;
        totals.cacheRead += delta.cacheRead;
        totals.cacheWrite += delta.cacheWrite;
        totals.reasoning += delta.reasoning;
        const stepCost = maybeNum(part.cost);
        if (stepCost !== null) {
          cost += stepCost;
          sawCost = true;
        }
        out.push({ t: 'usage', usage: delta, ...(stepCost !== null ? { cost: { usd: stepCost, basis: 'opencode step cost' } } : {}) });
      } else if (type === 'error') {
        const e = rec(msg.error);
        const data = rec(e.data);
        error = { name: str(e.name) ?? 'error', message: str(data.message) ?? str(e.name) ?? 'opencode error', status: maybeNum(data.statusCode) };
        out.push({ t: 'error', code: error.name, message: error.message, retryable: false });
      } else {
        out.push({ t: 'diagnostic', code: 'unknown_event', message: `unknown type ${type ?? '(none)'}` });
      }
      return out;
    },
    finish(exit) {
      const usage: RawUsage = {
        tokens: sawStepFinish ? { ...totals } : null,
        tokenBasis: sawStepFinish ? 'provider-reported' : 'unknown',
        semantics: sawStepFinish ? 'cache-disjoint' : 'unknown',
        reportedCostUsd: sawCost ? cost : null,
        reportedCostBasis: sawCost ? 'runner-reported' : null,
        reportedCostSource: sawCost ? 'opencode step_finish.cost (client-side price table)' : null,
      };
      if (exit.timedOut || exit.cancelled || exit.spawnError) return { ...exitFallback(exit, ''), usage, observedModel: null };
      if (error !== null) {
        const e: { name: string; message: string; status: number | null } = error;
        const code = codeForProviderError(e.status, `${e.name} ${e.message}`);
        return { termination: terminationForErrorCode(code), detail: `${e.name}: ${code}`, usage, observedModel: null };
      }
      if (exit.code === 0 && sawStepFinish) {
        if (lastReason === 'length') return { termination: 'budget', detail: 'output length', usage, observedModel: null };
        return { termination: 'completed', detail: `idle (${lastReason ?? 'stop'})`, usage, observedModel: null };
      }
      return { ...exitFallback(exit, 'exited without a finished step'), usage, observedModel: null };
    },
  };
}

export function createNativeParser(format: NativeFormat): NativeParser {
  switch (format) {
    case 'claude-stream-json':
      return claudeParser();
    case 'codex-jsonl':
      return codexParser();
    case 'opencode-json':
      return opencodeParser();
  }
}
