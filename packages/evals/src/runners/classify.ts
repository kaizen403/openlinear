import type { RunnerId } from '@openlinear/execution-core';
import type { Termination } from '../grading/outcome';
import type { TokenSemantics } from '../usage/cost';

/**
 * Maps runner error codes (execution-core `error.code`, see the W07 event
 * mapping) to a termination class. Platform failures are `infra`; caps are
 * `budget`; declines are `refused`; everything else is the agent's own error
 * (graded as is), mirroring Harbor's error policy (NonZeroAgentExitCode is
 * graded, provider/sandbox failures are not).
 */
const INFRA_CODES = new Set([
  'rate_limit',
  'overloaded',
  'server_error',
  'auth',
  'billing',
  'model_not_found',
  'network',
  'SANDBOX_UNAVAILABLE',
  'RUNNER_UNAVAILABLE',
  'RUNNER_AUTH_UNAVAILABLE',
  'RUNNER_NOT_SUPPORTED',
  'cancel_unconfirmed',
]);
const BUDGET_CODES = new Set(['budget_exhausted', 'context_overflow', 'max_turns', 'max_tokens', 'output_limit']);
const REFUSAL_CODES = new Set(['refusal', 'safety_refusal', 'content_policy']);

export function terminationForErrorCode(code: string | null): Termination {
  if (code === null) return 'agent-error';
  if (INFRA_CODES.has(code)) return 'infra';
  if (BUDGET_CODES.has(code)) return 'budget';
  if (REFUSAL_CODES.has(code)) return 'refused';
  return 'agent-error';
}

/** Provider-raw token semantics per runner family (see execution-core `reduceUsage`). */
export function semanticsForRunner(runner: RunnerId | string): TokenSemantics {
  if (runner === 'codex') return 'cache-in-input';
  if (runner === 'claude-code' || runner === 'opencode') return 'cache-disjoint';
  return 'unknown';
}
