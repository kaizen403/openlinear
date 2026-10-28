import { z } from 'zod';

/**
 * FE-02: the agent runners the execution engine knows (sidecar
 * `resolveAgentId`). Stored canonical; the aliases the sidecar has always
 * accepted are normalized here so a stored value is always one of the three.
 * Anything else is a validation error instead of a run that fails later with
 * INVALID_RUNNER.
 */
export const RUNNER_IDS = ['opencode', 'claude-code', 'codex'] as const;
export type RunnerIdValue = (typeof RUNNER_IDS)[number];

const ALIASES: Readonly<Record<string, RunnerIdValue>> = {
  opencode: 'opencode',
  'claude-code': 'claude-code',
  claude: 'claude-code',
  codex: 'codex',
  openai: 'codex',
  'openai-codex': 'codex',
};

export const runnerIdSchema = z.preprocess(
  (value) => (typeof value === 'string' ? ALIASES[value.trim().toLowerCase()] ?? value : value),
  z.enum(RUNNER_IDS, { errorMap: () => ({ message: `Agent must be one of ${RUNNER_IDS.join(', ')}` }) }),
);
