import { spawn, ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { createOpencodeClient } from '@opencode-ai/sdk';
import type { OpencodeClient, Config as OpenCodeServerConfig } from '@opencode-ai/sdk';
import { broadcastToAll } from '@openlinear/api/sse';
import { logger } from '@openlinear/api/logger';

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
let shutdownPromise: Promise<void> | null = null;
let initPromise: Promise<void> | null = null;

// T2 (C-03) — the agent subprocess must never inherit the sidecar's ambient
// environment. `process.env` on the sidecar holds DATABASE_URL, JWT_SECRET,
// TOKEN_ENCRYPTION_KEY, GITHUB_CLIENT_SECRET, GITHUB_TOKEN, and provider keys —
// OpenCode forwards all of it to every `bash` tool call the model makes, so a
// prompt-injected task description can exfiltrate every secret the process
// holds. Provider credentials are NOT part of this allowlist: OpenCode stores
// them itself in `~/.local/share/opencode/auth.json` (or `OPENCODE_AUTH_CONTENT`)
// via `client.auth.set()` (see routes/opencode.ts), so the spawned process
// never needs them handed in through the environment.
const ENV_ALLOWLIST_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  // Windows equivalents — harmless to allow, never populated with secrets.
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ComSpec',
]);
const ENV_ALLOWLIST_PREFIXES = ['LC_', 'XDG_', 'OPENCODE_'];

/**
 * Builds the child environment for the OpenCode subprocess from an explicit
 * allowlist rather than spreading the sidecar's own `process.env`. Everything
 * not matched here — including every OpenLinear secret — is absent, not just
 * undocumented.
 */
export function buildAgentEnv(sourceEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST_EXACT.has(key) || ENV_ALLOWLIST_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  return env;
}

// T3 (R1 P0-1/P0-2/P1-9) — OpenCode's default `build` agent ruleset is
// `"*": "allow"` except `doom_loop: "ask"`, `external_directory: {"*": "ask", ...}`,
// and `read: {"*.env": "ask", "*.env.*": "ask"}` (verified against
// packages/opencode/src/agent/agent.ts in the upstream source, per R1 §3.9 —
// this is NOT fully reflected in the pinned @opencode-ai/sdk@1.2.5 `Config`
// type, whose `permission` field only models `edit`/`bash`/`webfetch`/
// `doom_loop`/`external_directory`, no `read`). `Permission.ask` blocks on a
// Deferred with no timeout (R1 §3.9), so a headless run that trips any of
// these hangs forever. We deny them outright instead: `Permission.evaluate`
// is last-match-wins, so setting `doom_loop`/`external_directory` here (as
// flat "deny", the same shape the upstream default uses for `doom_loop`)
// overrides the "ask" default, and setting only the `.env*` patterns under
// `read` overrides just those two entries while leaving the default `read: "*":
// "allow"` untouched for everything else.
//
// `compaction` is likewise absent from the pinned SDK's `Config` type but is
// a real, documented `opencode.json` field (packages/opencode/src/session/
// compaction.ts, R1 §3.4) — the SDK's generated `Config` type appears to only
// cover the subset accepted by `PUT /config`, not the full config-file schema
// consumed at startup via `OPENCODE_CONFIG_CONTENT`. We widen the local type
// rather than editing the vendored SDK types.
type AgentOpenCodeConfig = OpenCodeServerConfig & {
  permission?: OpenCodeServerConfig['permission'] & {
    read?: Record<string, 'ask' | 'allow' | 'deny'>;
  };
  compaction?: {
    auto?: boolean;
    prune?: boolean;
    reserved?: number;
    tail_turns?: number;
    preserve_recent_tokens?: number;
  };
};

function buildAgentConfig(): AgentOpenCodeConfig {
  return {
    autoupdate: false,
    share: 'disabled',
    permission: {
      doom_loop: 'deny',
      external_directory: 'deny',
      read: {
        '*.env': 'deny',
        '*.env.*': 'deny',
        '*.env.example': 'allow',
      },
    },
    compaction: { auto: true, prune: true },
  };
}

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

// T12 (F18) — OpenCode is spawned `detached: true` (its own process group), so
// signalling the *group* (negative pid) reaches OpenCode's own bash/tool
// children too, not just the immediate opencode process. `proc.kill()` alone
// only signals the single process, leaving any subprocess it started (a
// `bash` tool call, a background npm install, etc.) as an orphan when the
// sidecar shuts down.
function signalProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (pid !== undefined) {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // No such process group (already dead) or platform doesn't support
      // negative-pid group signalling (e.g. Windows) — fall back to signalling
      // just the one process below.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // process may already be dead in race; treat as success
  }
}

async function killProcess(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;

  signalProcessGroup(proc, 'SIGTERM');

  await new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      /* v8 ignore next -- duplicate exit/timer resolution is a process race guard. */
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        signalProcessGroup(proc, 'SIGKILL');
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
    env: {
      ...buildAgentEnv(),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(buildAgentConfig()),
    },
    // Own process group so shutdown can signal OpenCode *and* every bash/tool
    // child it spawned, instead of leaving them reparented to init (C-05/T12).
    detached: true,
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

    logger.warn(
      `[OpenCode] Port ${OPENCODE_PORT} is unavailable. Retrying with dynamic port fallback.`,
    );
    return spawnOpencodeServer(bin, OPENCODE_HOST, 0, OPENCODE_TIMEOUT);
  }
}

function attachExitWatcher(handle: ServerHandle) {
  handle.proc.once('exit', (code, signal) => {
    if (shuttingDown) return;
    /* v8 ignore start -- stale-handle guard for overlapping crash/restart races. */
    if (serverHandle !== handle) return;
    /* v8 ignore stop */
    logger.warn(
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
  /* v8 ignore start -- concurrent restart/shutdown guard; crash restart is covered. */
  if (restarting || shuttingDown) return;
  /* v8 ignore stop */
  /* v8 ignore start -- exhaustion requires repeated failed restarts; normal crash restart is covered. */
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    logger.error(
      `[OpenCode] giving up after ${restartAttempts} restart attempts.`,
    );
    broadcastToAll('opencode:status', { status: 'unrecoverable' });
    return;
  }
  /* v8 ignore stop */
  restarting = true;
  const delay = RESTART_BACKOFF_BASE_MS * Math.pow(2, restartAttempts);
  restartAttempts += 1;
  logger.info(
    `[OpenCode] restart attempt ${restartAttempts} in ${delay}ms`,
  );
  await new Promise((r) => setTimeout(r, delay));
  restarting = false;
  try {
    await initOpenCode({ restart: true });
  /* v8 ignore start -- recursive retry after a failed restart uses the same scheduler path. */
  } catch (err) {
    logger.error({ err }, '[OpenCode] restart attempt failed');
    void scheduleRestart();
  }
  /* v8 ignore stop */
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
  if (initPromise) return initPromise;
  initPromise = _doInitOpenCode(opts).finally(() => { initPromise = null; });
  return initPromise;
}

async function _doInitOpenCode(opts: { restart?: boolean }): Promise<void> {
  if (serverHandle) return;
  const bin = resolveOpencodeBinary();
  logger.info(`[OpenCode] Using binary: ${bin}`);

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
    logger.info(`[OpenCode] Server running at ${handle.url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, '[OpenCode] Failed to start server');
    broadcastToAll('opencode:status', { status: 'error', error: message });
    throw err;
  }
}

/**
 * T12 — the single idempotent shutdown entry point for the OpenCode child.
 *
 * Concurrent/duplicate calls (this module's own signal handlers firing
 * alongside index.ts's, or a restart racing a shutdown) must not each try to
 * close the same handle twice. Callers get back the *same* in-flight promise
 * rather than a fresh no-op, so awaiting this from more than one call site is
 * safe and actually waits for the real close to finish.
 *
 * NOTE for the sidecar-bootstrap owner (index.ts, not owned by this change):
 * index.ts's own `shutdown()` currently closes its HTTP servers and
 * disconnects Prisma, then calls `process.exit(0)` — it never calls this
 * function. Meanwhile `registerShutdownHandlers()` below registers a
 * *second*, independent SIGTERM/SIGINT listener that calls this function
 * asynchronously. Node invokes both listeners, and whichever reaches
 * `process.exit()` first wins — so index.ts's faster path can exit the
 * process before OpenCode has been signalled at all. The structural fix is
 * for index.ts's `shutdown()` to `await shutdownOpenCode()` itself (this
 * function is idempotent, so it is safe to also leave the listener below
 * registered during the transition) and, once that lands, delete
 * `registerShutdownHandlers()`'s own `process.on` calls so there is exactly
 * one signal handler. Flagged in the Phase 0 report; not made here because
 * index.ts is owned by another workstream.
 */
export function shutdownOpenCode(): Promise<void> {
  // De-dupe *concurrent* callers (this module's own signal handler firing
  // alongside another caller) so they share one in-flight close rather than
  // each racing `serverHandle.close()` independently. Once it settles, the
  // guard clears — a later `shutdownOpenCode()` call (e.g. after a manual
  // restart re-established a new `serverHandle`) still does real work rather
  // than replaying a stale resolved promise.
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  const handle = serverHandle;
  // `handle.close()` is `killProcess`, whose exitCode guard and
  // `signalProcessGroup(proc, 'SIGTERM')` call run synchronously (before its
  // own first `await`) the moment it's invoked below — i.e. the signal is
  // already sent before this function returns, even without an explicit
  // `await` here. See the note above on why that matters for the race with
  // index.ts's competing exit path.
  shutdownPromise = (async () => {
    try {
      if (handle) {
        await handle.close();
        if (serverHandle === handle) {
          serverHandle = null;
        }
      }
      broadcastToAll('opencode:status', { status: 'stopped' });
    } finally {
      shutdownPromise = null;
    }
  })();
  return shutdownPromise;
}

export function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    logger.info(`[OpenCode] Received ${signal}, shutting down...`);
    await shutdownOpenCode();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('beforeExit', () => void shutdownOpenCode());
}

export interface IOpenCodeAdapter {
  init(opts?: { restart?: boolean }): Promise<void>;
  shutdown(): Promise<void>;
  getClient(userId: string, directory?: string): Promise<OpencodeClient>;
  getStatus(): OpenCodeStatus;
  isRunning(): boolean;
}

export class OpenCodeAdapter implements IOpenCodeAdapter {
  async init(opts: { restart?: boolean } = {}): Promise<void> {
    return initOpenCode(opts);
  }

  async shutdown(): Promise<void> {
    return shutdownOpenCode();
  }

  async getClient(userId: string, directory?: string): Promise<OpencodeClient> {
    return getClientForUser(userId, directory);
  }

  getStatus(): OpenCodeStatus {
    return getOpenCodeStatus();
  }

  isRunning(): boolean {
    return serverHandle !== null;
  }
}

export const openCodeAdapter = new OpenCodeAdapter();
