import { spawn } from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

/** Absolute, existing, executable regular file (after resolving symlinks). */
export function executableFile(candidate: string | undefined | null): string | null {
  if (!candidate || !isAbsolute(candidate)) return null;
  try {
    const real = realpathSync.native(candidate);
    if (!statSync(real).isFile()) return null;
    accessSync(real, constants.X_OK);
    return real;
  } catch {
    return null;
  }
}

/** First executable `name` on PATH. Relative PATH entries are ignored. */
export function findOnPath(name: string, pathEnv: string | undefined): string | null {
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const found = executableFile(join(dir, name));
    if (found) return found;
  }
  return null;
}

export interface ShortCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
}

/**
 * Runs a short, non-inference command (`--version`, a status query) with an
 * explicit environment, a timeout that kills the whole process group, and
 * bounded output. Never throws.
 */
export function runShortCommand(
  binary: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd?: string; timeoutMs?: number; maxBytes?: number },
): Promise<ShortCommandResult> {
  const maxBytes = options.maxBytes ?? 64 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result: ShortCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, options.timeoutMs ?? 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => finish({ code: null, stdout, stderr, timedOut, error: err.message }));
    child.once('close', (code) => finish({ code, stdout, stderr, timedOut }));
  });
}

/** `2.1.310 (Claude Code)` / `codex-cli 0.164.0` → `[2, 1, 310]`. */
export function parseSemver(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function semverAtLeast(version: [number, number, number] | null, wanted: [number, number, number]): boolean {
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== wanted[index]) return version[index] > wanted[index];
  }
  return true;
}
