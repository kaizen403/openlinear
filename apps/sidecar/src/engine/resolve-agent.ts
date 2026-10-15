import type { RunnerId } from '@openlinear/execution-core';
import { HttpError } from '@openlinear/api/errors';

export function resolveAgentId(input: {
  taskAgent?: string | null;
  projectDefaultAgent?: string | null;
}): RunnerId {
  const raw = (input.taskAgent ?? input.projectDefaultAgent ?? 'opencode').trim().toLowerCase();
  if (raw === 'opencode') return 'opencode';
  if (raw === 'codex' || raw === 'openai' || raw === 'openai-codex') return 'codex';
  if (raw === 'claude-code' || raw === 'claude') return 'claude-code';
  throw new HttpError(400, 'INVALID_RUNNER', 'The selected agent runner is unknown', { runner: raw });
}

/** The active legacy engine is OpenCode-only until coordinator migration. */
export function requireLegacyRunner(input: Parameters<typeof resolveAgentId>[0]): 'opencode' {
  const runner = resolveAgentId(input);
  if (runner !== 'opencode') {
    throw new HttpError(400, 'RUNNER_NOT_SUPPORTED', `The current execution engine does not support ${runner}`, {
      runner,
      supportedRunners: ['opencode'],
    });
  }
  return runner;
}
