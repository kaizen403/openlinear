import { spawn, ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { broadcastToAll } from '@openlinear/api/sse';

// OpenCode treats port 0 as "try 4096, then fall back to any free port".
// Using it by default avoids crashing when a user's own opencode server is already running.
const OPENCODE_PORT = parseInt(process.env.OPENCODE_PORT || '0', 10);
const OPENCODE_HOST = process.env.OPENCODE_HOST || '127.0.0.1';
const OPENCODE_TIMEOUT = parseInt(process.env.OPENCODE_TIMEOUT || '10000', 10);
const KILL_GRACE_MS = parseInt(process.env.OPENCODE_KILL_GRACE_MS || '3000', 10);
const MAX_RESTART_ATTEMPTS = 5;
const RESTART_BACKOFF_BASE_MS = 1000;

interface ServerHandle {
  url: string;
  proc: ChildProcess;
  close(): Promise<void>;
}

let serverHandle: ServerHandle | null = null;
let restartAttempts = 0;
let restarting = false;
let shuttingDown = false;

function resolveOpencodeBinary(): string {
  if (process.env.OPENCODE_BIN) {
    return process.env.OPENCODE_BIN;
  }

  const binDir = dirname(process.execPath);
  const platform = process.platform;
  const arch = process.arch;

  let triple: string;
  if (platform === 'darwin') {
    triple = arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  } else {
    triple = arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }

  const bundled = join(binDir, `opencode-${triple}`);
  if (existsSync(bundled)) {
    return bundled;
  }

  return 'opencode';
}

async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;

  try {
    proc.kill('SIGTERM');
  } catch {
    // process may already be dead in race; treat as success
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // process may already be dead in race; treat as success
        }
      }
      finish();
    }, KILL_GRACE_MS);
    proc.once('exit', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

function spawnOpencodeServer(
  bin: string,
  hostname: string,
  port: number,
  timeout: number,
): Promise<ServerHandle> {
  const args = ['serve', `--hostname=${hostname}`, `--port=${port}`];
  const proc = spawn(bin, args, {
    env: { ...process.env },
  });

  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      void killProcess(proc);
      reject(new Error(`opencode server did not start within ${timeout}ms`));
    }, timeout);

    let output = '';
    let resolved = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
          if (!match) {
            clearTimeout(id);
            void killProcess(proc);
            reject(new Error(`Failed to parse server URL from: ${line}`));
            return;
          }
          clearTimeout(id);
          resolved = true;
          resolve({
            url: match[1],
            proc,
            close: () => killProcess(proc),
          });
          return;
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(id);
      if (!resolved) {
        reject(
          new Error(
            `opencode exited with code ${code} signal ${signal} during startup\n${output}`,
          ),
        );
      }
    });

    proc.on('error', (err) => {
      clearTimeout(id);
      if (!resolved) reject(err);
    });
  });
}

function canRetryWithDynamicPort(err: unknown, port: number): boolean {
  if (port === 0) return false;
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes(`Failed to start server on port ${port}`) ||
    message.includes('EADDRINUSE')
  );
}

async function startOpencodeServer(bin: string): Promise<ServerHandle> {
  try {
    return await spawnOpencodeServer(bin, OPENCODE_HOST, OPENCODE_PORT, OPENCODE_TIMEOUT);
  } catch (err) {
    if (!canRetryWithDynamicPort(err, OPENCODE_PORT)) throw err;

    console.warn(
      `[OpenCode] Port ${OPENCODE_PORT} is unavailable. Retrying with dynamic port fallback.`,
    );
    return spawnOpencodeServer(bin, OPENCODE_HOST, 0, OPENCODE_TIMEOUT);
  }
}

function attachExitWatcher(handle: ServerHandle) {
  handle.proc.once('exit', (code, signal) => {
    if (shuttingDown) return;
    if (serverHandle !== handle) return;
    console.warn(
      `[OpenCode] server exited unexpectedly (code=${code}, signal=${signal}). Scheduling restart.`,
    );
    serverHandle = null;
    broadcastToAll('opencode:status', {
      status: 'crashed',
      code,
      signal,
    });
    void scheduleRestart();
  });
}

async function scheduleRestart() {
  if (restarting || shuttingDown) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error(
      `[OpenCode] giving up after ${restartAttempts} restart attempts.`,
    );
    broadcastToAll('opencode:status', { status: 'unrecoverable' });
    return;
  }
  restarting = true;
  const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, restartAttempts);
  restartAttempts += 1;
  console.log(
    `[OpenCode] restart attempt ${restartAttempts} in ${delay}ms`,
  );
  await new Promise((r) => setTimeout(r, delay));
  restarting = false;
  try {
    await initOpenCode({ restart: true });
  } catch (err) {
    console.error('[OpenCode] restart attempt failed:', err);
    void scheduleRestart();
  }
}

export async function getClientForUser(userId: string, directory?: string): Promise<OpencodeClient> {
  if (!serverHandle) {
    throw new Error('OpenCode server is not running. Call initOpenCode() first.');
  }

  // userId is accepted for future per-user isolation (see docs/limitations.md).
  // Today it is recorded only for log correlation; the client targets the shared server.
  void userId;

  return createOpencodeClient({
    baseUrl: serverHandle.url,
    ...(directory ? { directory } : {}),
  });
}

export interface OpenCodeStatus {
  mode: 'host';
  serverUrl: string | null;
  running: boolean;
  restartAttempts: number;
}

export function getOpenCodeStatus(): OpenCodeStatus {
  return {
    mode: 'host',
    serverUrl: serverHandle?.url ?? null,
    running: serverHandle !== null,
    restartAttempts,
  };
}

export async function initOpenCode(opts: { restart?: boolean } = {}): Promise<void> {
  if (serverHandle) return;
  const bin = resolveOpencodeBinary();
  console.log(`[OpenCode] Using binary: ${bin}`);

  try {
    const handle = await startOpencodeServer(bin);
    serverHandle = handle;
    attachExitWatcher(handle);
    if (!opts.restart) {
      restartAttempts = 0;
    } else {
      restartAttempts = 0;
    }
    broadcastToAll('opencode:status', { status: 'ready', mode: 'host', url: handle.url });
    console.log(`[OpenCode] Server running at ${handle.url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[OpenCode] Failed to start server:', err);
    broadcastToAll('opencode:status', { status: 'error', error: message });
    throw err;
  }
}

export async function shutdownOpenCode(): Promise<void> {
  shuttingDown = true;
  if (serverHandle) {
    await serverHandle.close();
    serverHandle = null;
  }
  broadcastToAll('opencode:status', { status: 'stopped' });
}

export function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`[OpenCode] Received ${signal}, shutting down...`);
    await shutdownOpenCode();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('beforeExit', () => void shutdownOpenCode());
}
