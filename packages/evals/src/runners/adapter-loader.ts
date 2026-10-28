import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentRunner } from '@openlinear/execution-core';

/**
 * Loads a real runner adapter at run time without a compile-time dependency
 * on apps/sidecar (which other engineers are changing). The module must
 * export `pickRunner({ taskAgent })` (as `apps/sidecar/src/runners/index.ts`
 * does) or a `createEvalRunner(runnerId)` factory. Run the CLI with `tsx` so
 * TypeScript sources load. The returned object is shape-checked against the
 * execution-core `AgentRunner` contract.
 *
 * Real adapters spawn real agent CLIs under the sidecar's verified sandbox
 * (or an audited trusted-host grant); they are only for funded runs.
 */

function isAgentRunner(value: unknown): value is AgentRunner {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.capabilities === 'object' &&
    typeof candidate.start === 'function' &&
    typeof candidate.resume === 'function' &&
    typeof candidate.healthCheck === 'function' &&
    typeof candidate.listModels === 'function'
  );
}

export async function loadRunnerAdapter(modulePath: string, runnerId: string): Promise<AgentRunner> {
  const absolute = isAbsolute(modulePath) ? modulePath : resolve(process.cwd(), modulePath);
  const mod: unknown = await import(pathToFileURL(absolute).href);
  if (typeof mod !== 'object' || mod === null) throw new Error(`${modulePath}: not a module`);
  const exports = mod as Record<string, unknown>;
  let runner: unknown;
  if (typeof exports.createEvalRunner === 'function') runner = await exports.createEvalRunner(runnerId);
  else if (typeof exports.pickRunner === 'function') runner = exports.pickRunner({ taskAgent: runnerId, projectDefaultAgent: null });
  else throw new Error(`${modulePath} exports neither createEvalRunner nor pickRunner`);
  if (!isAgentRunner(runner)) throw new Error(`${modulePath} did not return an execution-core AgentRunner for ${runnerId}`);
  if (runner.id !== runnerId) throw new Error(`${modulePath} returned runner ${runner.id}, expected ${runnerId}`);
  return runner;
}
