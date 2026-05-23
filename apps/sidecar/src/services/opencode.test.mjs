import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(),
  createOpencodeClient: vi.fn(),
  broadcastToAll: vi.fn(),
}));

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
  vi.doMock('@openlinear/api/sse', () => ({
    broadcastToAll: mocks.broadcastToAll,
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:fs');
    vi.doUnmock('@opencode-ai/sdk');
    vi.doUnmock('@openlinear/api/sse');
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
    ], { env: expect.any(Object) });
    expect(subject.getOpenCodeStatus()).toEqual({
      mode: 'host',
      serverUrl: 'http://0.0.0.0:3210',
      running: true,
      restartAttempts: 0,
    });

    await expect(subject.getClientForUser('user-1', '/repo')).resolves.toEqual({ client: true });
    expect(mocks.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://0.0.0.0:3210',
      directory: '/repo',
    });

    await expect(subject.getClientForUser('user-1')).resolves.toEqual({ client: true });
    expect(mocks.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: 'http://0.0.0.0:3210',
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
    ], { env: expect.any(Object) });
    expect(mocks.spawn).toHaveBeenNthCalledWith(2, '/custom/opencode', [
      'serve',
      '--hostname=127.0.0.1',
      '--port=0',
    ], { env: expect.any(Object) });
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

  it('registers process shutdown handlers', async () => {
    const handlers = new Map();
    const on = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return process;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    subject.registerShutdownHandlers();

    expect(on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(on).toHaveBeenCalledWith('beforeExit', expect.any(Function));

    handlers.get('SIGINT')();
    handlers.get('SIGTERM')();
    handlers.get('beforeExit')();
    await Promise.resolve();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('broadcasts stopped even when shutdown is called without a running server', async () => {
    const subject = await importSubject({ OPENCODE_BIN: '/custom/opencode' });

    await subject.shutdownOpenCode();

    expect(mocks.broadcastToAll).toHaveBeenCalledWith('opencode:status', { status: 'stopped' });
  });
});
