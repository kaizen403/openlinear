import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(),
  createOpencodeClient: vi.fn(),
  broadcastToAll: vi.fn(),
  attemptRoute: vi.fn(),
  attemptShutdownAll: vi.fn(),
  attemptRelease: vi.fn(),
  attemptMetadataFor: vi.fn(),
  attemptDeps: [],
}));

// W09a: directory-scoped clients go through the per-attempt sandbox manager.
// It is replaced here so these tests stay about process management; the
// manager itself is covered in sandbox/opencode-attempts.test.ts.
class FakeAttemptServerManager {
  constructor(deps) {
    mocks.attemptDeps.push(deps);
  }
  route(...args) { return mocks.attemptRoute(...args); }
  shutdownAll() { return mocks.attemptShutdownAll(); }
  release(directory) { return mocks.attemptRelease(directory); }
  metadataFor(directory) { return mocks.attemptMetadataFor(directory); }
}

function makeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.kill = vi.fn(() => {
    queueMicrotask(() => {
      proc.exitCode = 0;
      proc.emit('exit', 0, null);
    });
    return true;
  });
  return proc;
}

async function importSubject(env = {}) {
  vi.resetModules();
  delete process.env.OPENCODE_BIN;
  delete process.env.OPENCODE_PORT;
  delete process.env.OPENCODE_HOST;
  delete process.env.OPENCODE_TIMEOUT;
  delete process.env.OPENCODE_KILL_GRACE_MS;
  Object.assign(process.env, env);

  vi.doMock('node:child_process', () => ({
    ChildProcess: class ChildProcess {},
    spawn: mocks.spawn,
  }));
  vi.doMock('node:fs', () => ({
    existsSync: mocks.existsSync,
  }));
  vi.doMock('@opencode-ai/sdk', () => ({
    createOpencodeClient: mocks.createOpencodeClient,
  }));
  vi.doMock('../events/publisher', () => ({
    publishGlobalEvent: mocks.broadcastToAll,
  }));
  vi.doMock('../sandbox/opencode-attempts', () => ({
    AttemptServerManager: FakeAttemptServerManager,
  }));

  return import('./opencode');
}

async function startReady(subject, url = 'http://127.0.0.1:4096') {
  const pending = subject.initOpenCode();
  const proc = mocks.spawn.mock.results.at(-1).value;
  proc.stdout.emit('data', Buffer.from('warming up\n'));
  proc.stdout.emit('data', Buffer.from(`opencode server listening on ${url}\n`));
  await pending;
  return proc;
}

describe('opencode host process manager', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock?.mockReset === 'function') mock.mockReset();
    }
    mocks.existsSync.mockReturnValue(false);
    mocks.createOpencodeClient.mockReturnValue({ client: true });
    mocks.attemptDeps.length = 0;
    // Default: an explicit trusted-host grant, i.e. the legacy shared server.
    mocks.attemptRoute.mockResolvedValue({ kind: 'trusted-host', metadata: { mode: 'trusted-host' } });
    mocks.attemptShutdownAll.mockResolvedValue(undefined);
    mocks.attemptRelease.mockResolvedValue(undefined);
    mocks.attemptMetadataFor.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.doUnmock('@opencode-ai/sdk');
    vi.doUnmock('../events/publisher');
    vi.doUnmock('../sandbox/opencode-attempts');
    delete process.env.OPENCODE_BIN;
    delete process.env.OPENCODE_PORT;
    delete process.env.OPENCODE_HOST;
    delete process.env.OPENCODE_TIMEOUT;
    delete process.env.OPENCODE_KILL_GRACE_MS;
  });

  it('spawns the configured OpenCode binary and creates clients for users', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode', OPENCODE_HOST: '0.0.0.0' });

    await startReady(subject, 'http://0.0.0.0:3210');
    proc.emit('error', new Error('late startup error'));

    expect(mocks.spawn).toHaveBeenCalledWith('/custom/opencode', [
      'serve',
      '--hostname=0.0.0.0',
      '--port=0',
    ], { env: expect.any(Object), detached: true });
    expect(subject.getOpenCodeStatus()).toEqual({
      mode: 'host',
      serverUrl: 'http://0.0.0.0:3210',
      running: true,
      restartAttempts: 0,
    });

    // The shared server runs unsandboxed: a per-launch password, sent by every client.
    const password = mocks.spawn.mock.calls[0][2].env.OPENCODE_SERVER_PASSWORD;
    expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

    await expect(subject.getClientForUser('user-1', '/repo')).resolves.toEqual({ client: true });
    expect(mocks.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://0.0.0.0:3210',
      headers: { authorization },
      directory: '/repo',
    });

    await expect(subject.getClientForUser('user-1')).resolves.toEqual({ client: true });
    expect(mocks.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://0.0.0.0:3210',
      headers: { authorization },
    });
  });

  it('skips spawning when the server is already running and shuts it down cleanly', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    await startReady(subject);
    await subject.initOpenCode();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);

    await subject.shutdownOpenCode();

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(subject.getOpenCodeStatus().running).toBe(false);
    expect(mocks.broadcastToAll).toHaveBeenLastCalledWith('opencode:status', { status: 'stopped' });

    const exitedProc = makeProc();
    exitedProc.exitCode = 0;
    mocks.spawn.mockReturnValueOnce(exitedProc);
    await startReady(subject);
    await subject.shutdownOpenCode();

    expect(exitedProc.kill).not.toHaveBeenCalled();
  });

  it('escalates shutdown when SIGTERM does not exit the process', async () => {
    vi.useFakeTimers();
    const proc = makeProc();
    proc.kill = vi.fn(() => true);
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode', OPENCODE_KILL_GRACE_MS: '25' });

    await startReady(subject);
    const stopped = subject.shutdownOpenCode();
    await vi.advanceTimersByTimeAsync(25);
    await stopped;
    proc.emit('exit', 0, null);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not escalate when the process exits before the kill grace timer fires', async () => {
    vi.useFakeTimers();
    const proc = makeProc();
    proc.kill = vi.fn((signal) => {
      if (signal === 'SIGTERM') {
        proc.exitCode = 0;
      }
      return true;
    });
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode', OPENCODE_KILL_GRACE_MS: '25' });

    await startReady(subject);
    const stopped = subject.shutdownOpenCode();
    await vi.advanceTimersByTimeAsync(25);
    await stopped;

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.kill).not.toHaveBeenCalledWith('SIGKILL');
  });

  it('uses bundled binary paths when present and falls back to opencode otherwise', async () => {
    const bundledProc = makeProc();
    mocks.spawn.mockReturnValueOnce(bundledProc);
    mocks.existsSync.mockReturnValueOnce(true);
    const bundled = await importSubject();

    await startReady(bundled);
    expect(mocks.spawn.mock.calls[0][0]).toContain('opencode-');
    await bundled.shutdownOpenCode();

    const fallbackProc = makeProc();
    mocks.spawn.mockReturnValueOnce(fallbackProc);
    mocks.existsSync.mockReturnValueOnce(false);
    const fallback = await importSubject();

    await startReady(fallback);
    expect(mocks.spawn.mock.calls.at(-1)[0]).toBe('opencode');
  });

  it('resolves bundled binaries for alternate host platform triples', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const originalArch = Object.getOwnPropertyDescriptor(process, 'arch');
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
      const darwinProc = makeProc();
      mocks.spawn.mockReturnValueOnce(darwinProc);
      mocks.existsSync.mockReturnValueOnce(true);
      const darwin = await importSubject();

      await startReady(darwin);
      expect(mocks.spawn.mock.calls.at(-1)[0]).toContain('opencode-aarch64-apple-darwin');
      await darwin.shutdownOpenCode();

      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'x64', configurable: true });
      const darwinX64Proc = makeProc();
      mocks.spawn.mockReturnValueOnce(darwinX64Proc);
      mocks.existsSync.mockReturnValueOnce(true);
      const darwinX64 = await importSubject();

      await startReady(darwinX64);
      expect(mocks.spawn.mock.calls.at(-1)[0]).toContain('opencode-x86_64-apple-darwin');
      await darwinX64.shutdownOpenCode();

      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true });
      const linuxProc = makeProc();
      mocks.spawn.mockReturnValueOnce(linuxProc);
      mocks.existsSync.mockReturnValueOnce(true);
      const linux = await importSubject();

      await startReady(linux);
      expect(mocks.spawn.mock.calls.at(-1)[0]).toContain('opencode-aarch64-unknown-linux-gnu');
      await linux.shutdownOpenCode();
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform);
      Object.defineProperty(process, 'arch', originalArch);
    }
  });

  it('falls back to a dynamic port when the configured port is unavailable', async () => {
    const first = makeProc();
    const second = makeProc();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode', OPENCODE_PORT: '4096' });

    const pending = subject.initOpenCode();
    first.stderr.emit('data', Buffer.from('Failed to start server on port 4096'));
    first.emit('exit', 1, null);
    await Promise.resolve();
    second.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4100\n'));
    await pending;

    expect(mocks.spawn).toHaveBeenNthCalledWith(1, '/custom/opencode', [
      'serve',
      '--hostname=127.0.0.1',
      '--port=4096',
    ], { env: expect.any(Object), detached: true });
    expect(mocks.spawn).toHaveBeenNthCalledWith(2, '/custom/opencode', [
      'serve',
      '--hostname=127.0.0.1',
      '--port=0',
    ], { env: expect.any(Object), detached: true });
  });

  it('also falls back to a dynamic port on EADDRINUSE startup output', async () => {
    const first = makeProc();
    const second = makeProc();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode', OPENCODE_PORT: '4096' });

    const pending = subject.initOpenCode();
    first.stderr.emit('data', Buffer.from('EADDRINUSE'));
    first.emit('exit', 1, null);
    await Promise.resolve();
    second.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4100\n'));
    await pending;

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('reports startup parse errors and client access before readiness', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    await expect(subject.getClientForUser('user-1')).rejects.toThrow('OpenCode server is not running');

    const pending = subject.initOpenCode();
    proc.stdout.emit('data', Buffer.from('opencode server listening without url\n'));
    await expect(pending).rejects.toThrow('Failed to parse server URL');

    expect(mocks.broadcastToAll).toHaveBeenCalledWith(
      'opencode:status',
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('reports startup timeouts and child process errors', async () => {
    vi.useFakeTimers();
    const timeoutProc = makeProc();
    mocks.spawn.mockReturnValueOnce(timeoutProc);
    const timeoutSubject = await importSubject({ OPENCODE_BIN: '/custom/opencode', OPENCODE_TIMEOUT: '10' });

    const timedOut = expect(timeoutSubject.initOpenCode())
      .rejects.toThrow('opencode server did not start within 10ms');
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    expect(timeoutProc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.useRealTimers();
    const errorProc = makeProc();
    mocks.spawn.mockReturnValueOnce(errorProc);
    const errorSubject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    const failed = errorSubject.initOpenCode();
    errorProc.emit('error', 'spawn failed');
    await expect(failed).rejects.toBe('spawn failed');
    expect(mocks.broadcastToAll).toHaveBeenCalledWith('opencode:status', {
      status: 'error',
      error: 'spawn failed',
    });
  });

  it('retries dynamic port fallback for string-shaped address-in-use errors', async () => {
    const first = makeProc();
    const second = makeProc();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode', OPENCODE_PORT: '4096' });

    const pending = subject.initOpenCode();
    first.emit('error', 'EADDRINUSE');
    await Promise.resolve();
    second.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4102\n'));
    await pending;

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('broadcasts crash state and schedules a restart after unexpected exit', async () => {
    vi.useFakeTimers();
    const first = makeProc();
    const second = makeProc();
    mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    await startReady(subject);
    first.exitCode = 1;
    first.emit('exit', 1, 'SIGTERM');

    expect(mocks.broadcastToAll).toHaveBeenCalledWith('opencode:status', {
      status: 'crashed',
      code: 1,
      signal: 'SIGTERM',
    });

    await vi.advanceTimersByTimeAsync(1000);
    second.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4101\n'));
    await Promise.resolve();

    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('registers process shutdown handlers that trigger a graceful stop', async () => {
    // T12 — opencode.ts's own handlers only ever call `shutdownOpenCode()`;
    // they never call `process.exit` themselves (that remains index.ts's
    // responsibility — see the coordination note on `shutdownOpenCode`'s
    // docstring). This test previously asserted `process.exit` was called
    // from here, which this module has never done; corrected to assert the
    // real, documented effect (a graceful stop broadcast) instead of leaving
    // a stale assertion red.
    const handlers = new Map();
    const on = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return process;
    });
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
    await startReady(subject);

    subject.registerShutdownHandlers();

    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(on).toHaveBeenCalledWith('beforeExit', expect.any(Function));

    handlers.get('SIGTERM')();
    // The handler is fire-and-forget (`void shutdown(...)`), and shutdown
    // itself waits on the mock process's `exit` event (queued via
    // `queueMicrotask` in `makeProc`) before resolving — flush a few ticks.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mocks.broadcastToAll).toHaveBeenLastCalledWith('opencode:status', { status: 'stopped' });
    expect(subject.getOpenCodeStatus().running).toBe(false);
  });

  it('broadcasts stopped even when shutdown is called without a running server', async () => {
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    await subject.shutdownOpenCode();

    expect(mocks.broadcastToAll).toHaveBeenCalledWith('opencode:status', { status: 'stopped' });
  });
});

describe('T2 (C-03) — buildAgentEnv allowlist', () => {
  const SECRET_ENV = {
    DATABASE_URL: 'postgres://prod',
    JWT_SECRET: 'shh',
    TOKEN_ENCRYPTION_KEY: 'shh2',
    GITHUB_CLIENT_SECRET: 'shh3',
    GITHUB_TOKEN: 'ghp_abcdef',
    BRAINSTORM_API_KEY: 'shh4',
    ANTHROPIC_API_KEY: 'shh5',
    SOME_RANDOM_APP_SECRET: 'shh6',
  };
  const SAFE_ENV = {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/test',
    USER: 'test',
    LOGNAME: 'test',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    XDG_DATA_HOME: '/Users/test/.local/share',
    XDG_CONFIG_HOME: '/Users/test/.config',
    OPENCODE_MODELS_URL: 'https://models.opencode.ai',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  };

  it('excludes every OpenLinear secret from the produced env', async () => {
    const subject = await importSubject();
    const produced = subject.buildAgentEnv({ ...SECRET_ENV, ...SAFE_ENV });

    for (const key of Object.keys(SECRET_ENV)) {
      expect(produced).not.toHaveProperty(key);
    }
  });

  it('passes through the allowlisted keys and prefixes (PATH/HOME/LC_*/XDG_*/OPENCODE_*)', async () => {
    const subject = await importSubject();
    const produced = subject.buildAgentEnv({ ...SECRET_ENV, ...SAFE_ENV });

    expect(produced).toEqual(SAFE_ENV);
  });

  it('drops undefined values without crashing', async () => {
    const subject = await importSubject();
    const produced = subject.buildAgentEnv({ PATH: undefined, HOME: '/Users/test' });

    expect(produced).toEqual({ HOME: '/Users/test' });
  });

  it('defaults to the real process.env when no source is given', async () => {
    const subject = await importSubject();
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://should-not-leak';
    try {
      const produced = subject.buildAgentEnv();
      expect(produced).not.toHaveProperty('DATABASE_URL');
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});

describe('T3 (R1 P0-1/P0-2/P1-9) — injected OpenCode config', () => {
  it('sets OPENCODE_CONFIG_CONTENT with a deny ruleset and compaction enabled, built from the allowlisted env', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const originalDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgres://must-not-leak';
    try {
      const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
      await startReady(subject);

      const [, , spawnOptions] = mocks.spawn.mock.calls[0];
      expect(spawnOptions.env).not.toHaveProperty('DATABASE_URL');

      const config = JSON.parse(spawnOptions.env.OPENCODE_CONFIG_CONTENT);
      expect(config.permission.doom_loop).toBe('deny');
      expect(config.permission.external_directory).toBe('deny');
      expect(config.permission.read['*.env']).toBe('deny');
      expect(config.permission.read['*.env.*']).toBe('deny');
      expect(config.permission.read['*.env.example']).toBe('allow');
      expect(config.compaction).toEqual({ auto: true, prune: true });
      // W09a: the phantom `opencode-openlinear` plugin (no such package) is gone.
      expect(config).not.toHaveProperty('plugin');
    } finally {
      if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDbUrl;
    }
  });

  it('spawns the OpenCode process detached, in its own process group', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
    await startReady(subject);

    const [, , spawnOptions] = mocks.spawn.mock.calls[0];
    expect(spawnOptions.detached).toBe(true);
  });
});

describe('T12 (F18) — process-group signalling on shutdown', () => {
  it('signals the negative pid (the process group) when the child has a pid', async () => {
    const proc = makeProc();
    proc.pid = 4242;
    mocks.spawn.mockReturnValue(proc);
    // Simulate the OS actually reaping the process after the group signal —
    // real `process.kill(-pid, sig)` doesn't itself resolve when the child
    // exits, so `killProcess`'s wait needs the mock proc's `exit` event.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      queueMicrotask(() => {
        proc.exitCode = 0;
        proc.emit('exit', 0, null);
      });
      return true;
    });
    try {
      const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
      await startReady(subject);

      await subject.shutdownOpenCode();

      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });

  it('falls back to signalling the single process when group signalling throws', async () => {
    const proc = makeProc();
    proc.pid = 4243;
    mocks.spawn.mockReturnValue(proc);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });
    try {
      const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
      await startReady(subject);

      await subject.shutdownOpenCode();

      expect(killSpy).toHaveBeenCalledWith(-4243, 'SIGTERM');
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('falls back to signalling the single process when the child has no pid', async () => {
    const proc = makeProc();
    proc.pid = undefined;
    mocks.spawn.mockReturnValue(proc);
    const killSpy = vi.spyOn(process, 'kill');
    try {
      const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
      await startReady(subject);

      await subject.shutdownOpenCode();

      expect(killSpy).not.toHaveBeenCalled();
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('OpenCodeAdapter', () => {
  it('delegates all methods to the internal state', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    mocks.createOpencodeClient.mockReturnValue({ client: true });
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    const pending = subject.openCodeAdapter.init({ restart: true });
    proc.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:4321\n'));
    await pending;

    expect(subject.openCodeAdapter.isRunning()).toBe(true);
    expect(subject.openCodeAdapter.getStatus()).toEqual(expect.objectContaining({ running: true }));
    await expect(subject.openCodeAdapter.getClient('user-1')).resolves.toEqual({ client: true });

    await subject.openCodeAdapter.shutdown();
    expect(subject.openCodeAdapter.isRunning()).toBe(false);
  });
});

describe('W09a — per-attempt sandboxed servers', () => {
  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.createOpencodeClient.mockReset();
    mocks.createOpencodeClient.mockReturnValue({ client: true });
    mocks.broadcastToAll.mockReset();
    mocks.attemptDeps.length = 0;
    mocks.attemptRoute.mockReset();
    mocks.attemptRoute.mockResolvedValue({ kind: 'trusted-host', metadata: { mode: 'trusted-host' } });
    mocks.attemptShutdownAll.mockReset();
    mocks.attemptShutdownAll.mockResolvedValue(undefined);
    mocks.attemptRelease.mockReset();
    mocks.attemptRelease.mockResolvedValue(undefined);
    mocks.attemptMetadataFor.mockReset();
    mocks.attemptMetadataFor.mockReturnValue(null);
  });

  it('returns the attempt client for directory-scoped requests in enforce mode', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const attemptClient = { attempt: true };
    mocks.attemptRoute.mockResolvedValue({ kind: 'attempt', client: attemptClient, metadata: { mode: 'enforce' } });
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
    await startReady(subject);

    await expect(subject.getClientForUser('user-1', '/repo/worktree')).resolves.toBe(attemptClient);
    expect(mocks.attemptRoute).toHaveBeenCalledWith('user-1', '/repo/worktree');
    // The shared server is never handed out for an attempt in enforce mode.
    expect(mocks.createOpencodeClient).not.toHaveBeenCalledWith(expect.objectContaining({ directory: '/repo/worktree' }));
    // Management (no directory) calls still use the shared server.
    await subject.getClientForUser('user-1');
    expect(mocks.attemptRoute).toHaveBeenCalledTimes(1);
  });

  it('propagates SANDBOX_UNAVAILABLE without spawning anything for the attempt', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const unavailable = Object.assign(new Error('No verified sandbox'), { code: 'SANDBOX_UNAVAILABLE' });
    mocks.attemptRoute.mockRejectedValue(unavailable);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
    await startReady(subject);
    const spawnsBefore = mocks.spawn.mock.calls.length;

    await expect(subject.getClientForUser('user-1', '/repo/worktree')).rejects.toBe(unavailable);
    expect(mocks.spawn.mock.calls.length).toBe(spawnsBefore);
  });

  it('wires the manager to the sandboxed launcher and stops attempt servers on shutdown', async () => {
    const proc = makeProc();
    mocks.spawn.mockReturnValue(proc);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });
    await startReady(subject);
    await subject.getClientForUser('user-1', '/repo/worktree');
    const deps = mocks.attemptDeps.at(-1);

    expect(deps.resolveBinary()).toBe('/custom/opencode');
    expect(deps.agentConfig()).not.toHaveProperty('plugin');
    mocks.createOpencodeClient.mockReturnValueOnce({ config: { get: async () => ({ data: { model: 'anthropic/x' } }) } });
    await expect(deps.managementConfig()).resolves.toEqual({ model: 'anthropic/x' });
    deps.createClient({ baseUrl: 'http://127.0.0.1:1', directory: '/repo/worktree', headers: { authorization: 'Basic x' }, fetch });
    expect(mocks.createOpencodeClient).toHaveBeenLastCalledWith(expect.objectContaining({ headers: { authorization: 'Basic x' } }));
    deps.onEvent('sandbox:attempt', { attemptKey: 'k' });
    expect(mocks.broadcastToAll).toHaveBeenCalledWith('sandbox:attempt', { attemptKey: 'k' });

    const attemptProc = makeProc();
    mocks.spawn.mockReturnValueOnce(attemptProc);
    const launching = deps.launch({ command: '/usr/bin/sandbox-exec', args: ['-p', 'profile'], cwd: '/repo/worktree', env: { PATH: '/usr/bin' }, extraFds: [7] }, 1000);
    attemptProc.stdout.emit('data', Buffer.from('opencode server listening on http://127.0.0.1:5555\n'));
    await expect(launching).resolves.toEqual(expect.objectContaining({ url: 'http://127.0.0.1:5555' }));
    expect(mocks.spawn).toHaveBeenLastCalledWith('/usr/bin/sandbox-exec', ['-p', 'profile'], {
      cwd: '/repo/worktree',
      env: { PATH: '/usr/bin' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 7],
    });

    mocks.attemptMetadataFor.mockReturnValue({ mode: 'enforce', policyHash: 'abc' });
    expect(subject.getSandboxRunMetadata('/repo/worktree')).toEqual({ mode: 'enforce', policyHash: 'abc' });
    await subject.releaseAttemptServer('/repo/worktree');
    expect(mocks.attemptRelease).toHaveBeenCalledWith('/repo/worktree');

    await subject.shutdownOpenCode();
    expect(mocks.attemptShutdownAll).toHaveBeenCalledTimes(1);
    expect(subject.getSandboxRunMetadata('/repo/worktree')).toBeNull();
  });
});
