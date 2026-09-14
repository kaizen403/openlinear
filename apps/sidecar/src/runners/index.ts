import type { AgentRunner, RunnerId } from '@openlinear/execution-core';
import { OpenCodeRunner } from './opencode/index';
import { CodexRunner } from './codex/index';
import { resolveAgentId } from '../engine/resolve-agent';

const registry = new Map<string, AgentRunner>();

export function getRunnerRegistry(): Map<string, AgentRunner> {
  if (registry.size === 0) {
    const opencode = new OpenCodeRunner();
    const codex = new CodexRunner();
    registry.set('opencode', opencode);
    registry.set('codex', codex);
  }
  return registry;
}

export function pickRunner(input: {
  taskAgent?: string | null;
  projectDefaultAgent?: string | null;
}): AgentRunner {
  const id: RunnerId = resolveAgentId(input);
  if (id === 'claude-code') {
    throw new Error('Claude Code runner is Phase 4');
  }
  const runner = getRunnerRegistry().get(id);
  if (!runner) throw new Error(`Unknown runner ${id}`);
  return runner;
}

export { OpenCodeRunner, CodexRunner };
