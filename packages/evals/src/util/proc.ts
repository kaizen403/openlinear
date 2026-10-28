import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd: string;
  /** Complete environment. Nothing is inherited unless the caller passes it. */
  env: Record<string, string>;
  /** Wall-clock limit; the whole process group is stopped when it elapses. */
  timeoutMs?: number;
  /** SIGTERM → SIGKILL grace for the process group (default 2 s). */
  killGraceMs?: number;
  /** Written to stdin, which is then closed. Without it stdin is closed immediately. */
  input?: string;
  /** Called for every complete stdout line, in order. */
  onStdoutLine?: (line: string, atMs: number) => void;
  /** Retained stdout/stderr tail size in bytes (default 1 MiB each). */
  maxOutputBytes?: number;
  /** External cancellation; treated like a timeout but reported as `cancelled`. */
  signal?: AbortSignal;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** The process could not be started (e.g. ENOENT). */
  spawnError: string | null;
  durationMs: number;
}

function keepTail(current: string, chunk: string, max: number): string {
  const next = current + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Runs an argv (never a shell string) in its own process group. On timeout or
 * cancellation the group gets SIGTERM, then SIGKILL after the grace period,
 * so no descendant outlives the trial.
 */
export function runCommand(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = options.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let lineBuffer = '';
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false, spawnError: String(error), durationMs: 0 });
      return;
    }

    const stopGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }, options.killGraceMs ?? 2000);
      killTimer.unref();
    };

    const timer = options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          stopGroup();
        }, options.timeoutMs)
      : undefined;

    const onAbort = () => {
      cancelled = true;
      stopGroup();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout = keepTail(stdout, chunk, max);
      if (!options.onStdoutLine) return;
      lineBuffer += chunk;
      for (;;) {
        const index = lineBuffer.indexOf('\n');
        if (index === -1) break;
        const line = lineBuffer.slice(0, index);
        lineBuffer = lineBuffer.slice(index + 1);
        if (line.trim()) options.onStdoutLine(line, Date.now() - started);
      }
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = keepTail(stderr, chunk, max);
    });
    child.stdin?.on('error', () => undefined);
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();

    const finish = (code: number | null, signal: string | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (options.onStdoutLine && lineBuffer.trim()) options.onStdoutLine(lineBuffer, Date.now() - started);
      // Reap anything left in the group (a child that ignored SIGTERM, or a
      // daemonised grandchild) before reporting.
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // group already empty
        }
      }
      resolve({ code, signal, stdout, stderr, timedOut, cancelled, spawnError, durationMs: Date.now() - started });
    };
    child.on('error', (error) => finish(null, null, error.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

/** Minimal environment for helper processes (git, verifiers): PATH plus explicit additions. */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
  return { ...env, ...extra };
}
