import type { RunnerId } from '@openlinear/execution-core';

export function resolveAgentId(input: {
  taskAgent?: string | null;
  projectDefaultAgent?: string | null;
}): RunnerId {
  const raw = (input.taskAgent ?? input.projectDefaultAgent ?? 'opencode').toLowerCase();
  if (raw === 'codex' || raw === 'openai' || raw === 'openai-codex') return 'codex';
  if (raw === 'claude-code' || raw === 'claude') return 'claude-code';
  return 'opencode';
}
