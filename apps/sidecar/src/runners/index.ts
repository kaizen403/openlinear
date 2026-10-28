import type { AgentRunner, RunnerId } from '@openlinear/execution-core';
import { OpenCodeRunner } from './opencode/index';
import { CodexRunner } from './codex/index';
import { ClaudeCodeRunner } from './claude-code/index';
import { getRunnerCatalogue, type RunnerCatalogue, type RunnerCatalogueEntry } from './catalogue';
import { resolveAgentId } from '../engine/resolve-agent';

const registry = new Map<string, AgentRunner>();

export function getRunnerRegistry(): Map<string, AgentRunner> {
  if (registry.size === 0) {
    registry.set('opencode', new OpenCodeRunner());
    registry.set('codex', new CodexRunner());
    registry.set('claude-code', new ClaudeCodeRunner());
  }
  return registry;
}

/**
 * Returns the adapter for the task/project selection. Selecting an adapter
 * does not route ordinary execution through it: the legacy execute route
 * still refuses non-OpenCode runners with RUNNER_NOT_SUPPORTED
 * (`requireLegacyRunner`); native routing is W05/W07 integration.
 */
export function pickRunner(input: {
  taskAgent?: string | null;
  projectDefaultAgent?: string | null;
}): AgentRunner {
  const id: RunnerId = resolveAgentId(input);
  const runner = getRunnerRegistry().get(id);
  if (!runner) throw new Error(`Unknown runner ${id}`);
  return runner;
}

/** Read-only catalogue (sandbox state, capabilities, features, local health) for a runner picker. */
export function getRunnerCatalogueSnapshot(options?: { timeoutMs?: number }): Promise<RunnerCatalogue> {
  return getRunnerCatalogue(getRunnerRegistry().values(), options);
}

export { OpenCodeRunner, CodexRunner, ClaudeCodeRunner };
export type { RunnerCatalogue, RunnerCatalogueEntry };
