import { HttpError } from '../lib/errors';

/**
 * Raised instead of spawning an agent when no verified sandbox is available
 * and no valid trusted-host grant applies. Callers must treat it as "zero
 * spawn": nothing was started, nothing needs to be reaped.
 *
 * Extends HttpError so existing route/lifecycle error mapping surfaces the
 * structured `SANDBOX_UNAVAILABLE` code instead of a generic 500.
 */
export class SandboxUnavailableError extends HttpError {
  readonly blockers: readonly string[];

  constructor(message: string, blockers: readonly string[]) {
    super(503, 'SANDBOX_UNAVAILABLE', message, { blockers: [...blockers] });
    this.name = 'SandboxUnavailableError';
    this.blockers = [...blockers];
  }
}

/** The sandboxed process could not be started even though preflight passed. */
export class SandboxStartError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(503, 'SANDBOX_START_FAILED', message, details);
    this.name = 'SandboxStartError';
  }
}

/** A sandbox policy failed validation (bad path, unsafe root, …). */
export class SandboxPolicyError extends Error {
  readonly code = 'SANDBOX_POLICY_INVALID' as const;

  constructor(message: string) {
    super(message);
    this.name = 'SandboxPolicyError';
  }
}

export function isSandboxUnavailableError(err: unknown): err is SandboxUnavailableError {
  return err instanceof SandboxUnavailableError;
}
