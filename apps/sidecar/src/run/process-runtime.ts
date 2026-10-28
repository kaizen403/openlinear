import { execFile } from 'node:child_process';
import type { AgentSession, ModelRef, ResumeInput, RuntimeProbe, StartInput } from '@openlinear/execution-core';
import { HttpError } from '../lib/errors';
import { logger } from '../lib/logger';
import { ProcessAgentSession } from '../runners/shared/process-session';
import type { ResumeRuntimeInput, RunRuntime, StartedRuntimeSession } from './runtime';
import type { RuntimeEndpoint } from './types';

/**
 * W07a — Claude Code and Codex behind the run service.
 *
 * Both runners drive a CLI child process over stdio under the W09a sandbox
 * (`runners/shared/sandboxed-process`). That shapes their durable
 * semantics, which this adapter states honestly instead of pretending to
 * be OpenCode:
 *
 * - start spawns the process (sandbox, binary and credential failures
 *   surface here, before the claim); the prompt is written when the event
 *   stream is first consumed — after the run service journaled the prompt
 *   intent (journal before dispatch);
 * - inspect after a restart is always `detached`: the process's stdout was a
 *   pipe into the dead sidecar, so its events (including a possible turn
 *   result) are lost and cannot be re-attached. Recovery therefore ends
 *   `recovery_required` with the work retained, and never re-prompts;
 * - abort of a live session is the session's own confirmed stop (graceful
 *   ack or observed exit); abort of an orphan from a previous sidecar stops
 *   its process group only after verifying the journaled identity (pid is a
 *   group leader that started inside the launch window), so a recycled pid
 *   is never signalled. An orphan that is gone counts as stopped.
 * - follow-up turns resume the runner's saved session (`--resume <id>`,
 *   `codex exec resume <thread>`) when its session file still exists in the
 *   worktree's private runtime dir.
 */

export type ProcessRunnerId = 'claude-code' | 'codex';

/** What this adapter needs from `ClaudeCodeRunner` / `CodexRunner`. */
export interface ProcessRunner {
  readonly id: ProcessRunnerId;
  start(input: StartInput): Promise<AgentSession>;
  resume(externalSessionId: string, input: ResumeInput): Promise<AgentSession>;
  preflight(input: { env: Record<string, string> }): Promise<void>;
  canResume(sessionId: string, worktree: string): boolean;
  /** FE-04: whether the runner can hold a permission request for an answer. */
  readonly features?: { approvals: 'interactive' | 'policy-only' };
}

const PROVIDER_PREFIX: Readonly<Record<ProcessRunnerId, string>> = { 'claude-code': 'anthropic', codex: 'openai' };
const MODEL_ID = /^[A-Za-z0-9._:[\]-]{1,128}$/;

/**
 * The model id the runner's CLI accepts for a task model. `anthropic/x` →
 * `x` for Claude Code, `openai/x` → `x` for Codex; an id from another
 * provider (or one the CLI would silently ignore) is an unsupported
 * combination and fails before anything is dispatched.
 */
export function nativeModelFor(runner: ProcessRunnerId, model: string | null): ModelRef | null {
  if (!model) return null;
  const prefix = `${PROVIDER_PREFIX[runner]}/`;
  const id = model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (id.includes('/') || !MODEL_ID.test(id)) {
    throw new HttpError(400, 'RUNNER_NOT_SUPPORTED', `${runner} cannot run model ${model}; choose a ${PROVIDER_PREFIX[runner]} model for this runner or another runner for this model`, {
      runner,
      model,
      reason: 'model_provider_mismatch',
    });
  }
  return { provider: PROVIDER_PREFIX[runner], id };
}

// ---------------------------------------------------------------------------
// Orphan process control (process identity from the journal)
// ---------------------------------------------------------------------------

export type ProcessIdentity = NonNullable<RuntimeEndpoint['process']>;

export interface ProcessProbe {
  /** Process-group id and start time of `pid`, or null when no such process exists. */
  identify(pid: number): Promise<{ pgid: number; startedAt: number | null } | null>;
  signalGroup(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

/** `ps -o pgid=,lstart=` (macOS and procps), C locale; second resolution. */
export const systemProcessProbe: ProcessProbe = {
  identify(pid) {
    return new Promise((resolve) => {
      execFile('ps', ['-o', 'pgid=,lstart=', '-p', String(pid)], {
        timeout: 5_000,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...(process.env.TZ ? { TZ: process.env.TZ } : {}) },
      }, (error, stdout) => {
        const line = String(stdout ?? '').trim();
        if (error || !line) {
          resolve(null);
          return;
        }
        const match = /^(\d+)\s+(.+)$/.exec(line);
        if (!match?.[1] || !match[2]) {
          resolve(null);
          return;
        }
        const startedAt = Date.parse(match[2]);
        resolve({ pgid: Number(match[1]), startedAt: Number.isFinite(startedAt) ? startedAt : null });
      });
    });
  },
  signalGroup(pid, signal) {
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** ps reports whole seconds; spawn bookkeeping is a few ms off either way. */
const START_SLACK_MS = 2_000;

function isSameProcess(identity: ProcessIdentity, found: { pgid: number; startedAt: number | null }): boolean | null {
  if (identity.pid === null) return false;
  if (found.pgid !== identity.pid) return false;
  if (found.startedAt === null) return null;
  const earliest = (identity.launchedAt ?? identity.spawnedBy - 60_000) - START_SLACK_MS;
  return found.startedAt >= Math.floor(earliest / 1_000) * 1_000 && found.startedAt <= identity.spawnedBy + START_SLACK_MS;
}

/**
 * Stop a runtime process a previous sidecar left behind. True when it is
 * confirmed not running (gone, recycled pid, or stopped here); false when
 * that cannot be confirmed (no identity recorded, start time unreadable,
 * or it survived SIGKILL).
 */
export async function stopOrphanProcess(identity: ProcessIdentity | null | undefined, probe: ProcessProbe = systemProcessProbe, waitMs = 3_000): Promise<boolean> {
  if (!identity) return false;
  if (identity.pid === null) return true;
  const pid = identity.pid;
  const found = await probe.identify(pid);
  if (!found) return true;
  const same = isSameProcess(identity, found);
  if (same === false) return true;
  if (same === null) return false;
  const gone = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await probe.identify(pid);
      if (!current || isSameProcess(identity, current) === false) return true;
      if (Date.now() >= deadline) return false;
      await probe.sleep(100);
    }
  };
  probe.signalGroup(pid, 'SIGTERM');
  if (await gone(waitMs)) return true;
  probe.signalGroup(pid, 'SIGKILL');
  return gone(waitMs);
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface ProcessRuntimeDeps {
  probe?: ProcessProbe;
  now?: () => number;
}

export function createProcessRuntime(runner: ProcessRunner, deps: ProcessRuntimeDeps = {}): RunRuntime {
  const probe = deps.probe ?? systemProcessProbe;
  const now = deps.now ?? Date.now;
  /** Sessions of this process, by endpoint base URL (`process://<runner>/<runId>`). */
  const live = new Map<string, ProcessAgentSession>();

  const register = (runId: string, worktree: string, session: AgentSession, resumedSessionId: string | null): StartedRuntimeSession => {
    if (!(session instanceof ProcessAgentSession)) {
      throw new Error(`${runner.id} returned a session without process control`);
    }
    const info = session.processInfo;
    const endpoint: RuntimeEndpoint = {
      kind: runner.id,
      baseUrl: `process://${runner.id}/${runId}`,
      directory: worktree,
      authorization: null,
      sandboxMode: info?.mode ?? 'none',
      process: info ? { pid: info.pid, launchedAt: info.launchedAt, spawnedBy: now() } : null,
      ...(resumedSessionId ? { resumedSessionId } : {}),
    };
    live.set(endpoint.baseUrl, session);
    return { session, endpoint };
  };

  return {
    runnerId: runner.id,
    approvals: runner.features?.approvals ?? 'policy-only',

    async preflight(input) {
      nativeModelFor(runner.id, input.model);
      await runner.preflight({ env: input.env });
    },

    async start(input) {
      const model = nativeModelFor(runner.id, input.model?.id ?? null);
      const { model: _ignored, ...rest } = input;
      const session = await runner.start({ ...rest, ...(model ? { model } : {}) });
      return register(input.runId, input.worktreePath, session, null);
    },

    async resume(input: ResumeRuntimeInput) {
      if (!runner.canResume(input.sessionId, input.worktreePath)) return null;
      const model = nativeModelFor(runner.id, input.model?.id ?? null);
      const session = await runner.resume(input.sessionId, {
        worktreePath: input.worktreePath,
        signal: input.signal,
        prompt: input.prompt,
        permissions: input.permissions,
        env: input.env,
        ...(model ? { model } : {}),
      });
      return register(input.runId, input.worktreePath, session, input.sessionId);
    },

    async inspect(): Promise<Exclude<RuntimeProbe, 'not-probed'>> {
      return 'detached';
    },

    async attach() {
      throw new HttpError(409, 'RUNTIME_NOT_REATTACHABLE', `${runner.id} runs as a child process of the sidecar; its session cannot be re-attached after a restart`);
    },

    async abort(endpoint) {
      if (!endpoint) return false;
      const session = live.get(endpoint.baseUrl);
      if (session) {
        await session.abort().catch((error: unknown) => {
          logger.warn({ err: error, runner: runner.id }, '[RunEngine] process runtime abort failed');
        });
        return session.stopConfirmed === true;
      }
      return stopOrphanProcess(endpoint.process, probe);
    },

    async release(endpoint) {
      live.delete(endpoint.baseUrl);
    },
  };
}
