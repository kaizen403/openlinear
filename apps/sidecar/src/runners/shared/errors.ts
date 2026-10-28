import { HttpError } from '../../lib/errors';

/**
 * The runner's runtime cannot be used on this machine (binary missing, or a
 * version below the adapter's minimum). Raised before anything is spawned.
 */
export class RunnerUnavailableError extends HttpError {
  constructor(runner: string, message: string, details?: Record<string, unknown>) {
    super(503, 'RUNNER_UNAVAILABLE', message, { runner, ...details });
    this.name = 'RunnerUnavailableError';
  }
}

/**
 * No credential the runtime would use is reachable for this attempt: e.g. a
 * macOS Keychain login under an enforced sandbox, which deliberately does
 * not expose the Keychain. Raised before anything is spawned; the remedy is
 * an explicit per-run credential or a trusted-host grant, never a fallback.
 */
export class RunnerAuthUnavailableError extends HttpError {
  constructor(runner: string, message: string, details?: Record<string, unknown>) {
    super(412, 'RUNNER_AUTH_UNAVAILABLE', message, { runner, ...details });
    this.name = 'RunnerAuthUnavailableError';
  }
}
