/**
 * Named await points of the run service. Every await the service makes on
 * the way to a terminal decision goes through `step(point, …)`, so tests can
 * inject a failure before or after any of them (W05 "no reservation leak
 * after every injected await failure"), and the process-kill acceptance
 * test can SIGKILL the sidecar at an exact point.
 */
export type FaultPhase = 'before' | 'after';

export type FaultHook = (phase: FaultPhase, point: string, runId: string) => void | Promise<void>;

export const CRASH_AT_ENV = 'OPENLINEAR_RUN_ENGINE_CRASH_AT';

/**
 * Test-only crash points: `OPENLINEAR_RUN_ENGINE_CRASH_AT=<phase>:<point>`
 * (e.g. `after:effect:git.commit:receipt`) makes the sidecar SIGKILL itself
 * at that point. Honoured only when NODE_ENV=test; ignored otherwise.
 */
export function crashHookFromEnv(env: NodeJS.ProcessEnv = process.env, kill: () => void = () => process.kill(process.pid, 'SIGKILL')): FaultHook | null {
  const target = env[CRASH_AT_ENV]?.trim();
  if (!target || env.NODE_ENV !== 'test') return null;
  return (phase, point) => {
    if (`${phase}:${point}` !== target) return undefined;
    kill();
    // SIGKILL is asynchronous from the caller's view: never continue past the point.
    return new Promise<void>(() => undefined);
  };
}

export function composeFaultHooks(...hooks: Array<FaultHook | null | undefined>): FaultHook | null {
  const active = hooks.filter((hook): hook is FaultHook => typeof hook === 'function');
  if (active.length === 0) return null;
  return async (phase, point, runId) => {
    for (const hook of active) await hook(phase, point, runId);
  };
}
