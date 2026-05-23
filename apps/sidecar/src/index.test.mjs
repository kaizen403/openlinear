import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

function makeServer(options = {}) {
  const handlers = new Map();
  const server = {
    listening: options.listening ?? true,
    close: vi.fn((callback) => {
      if (options.close) {
        return options.close(callback);
      }
      callback?.(options.closeError);
      return undefined;
    }),
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
      return server;
    }),
    handlers,
  };
  return server;
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function loadIndex(options = {}) {
  vi.resetModules();
  restoreEnv();

  if (!options.defaultAutostart) {
    process.env.OPENLINEAR_SIDECAR_AUTOSTART = options.autostart ?? '0';
  }
  process.env.OPENLINEAR_SKIP_DOTENV = options.skipDotenv ?? '1';
  if (options.apiPort !== undefined) process.env.API_PORT = options.apiPort;
  if (options.frontendUrl !== undefined) process.env.FRONTEND_URL = options.frontendUrl;
  if (options.interceptorPort !== undefined) {
    process.env.OAUTH_INTERCEPTOR_PORT = options.interceptorPort;
  }
  if (options.bindHost !== undefined) process.env.SIDECAR_BIND_HOST = options.bindHost;
  if (options.allowSharedOpenCode) process.env.OPENLINEAR_ALLOW_SHARED_OPENCODE = '1';

  const processHandlers = new Map();
  const exitCodes = [];
  const logger = {
    error: vi.fn(),
    fatal: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const apiServer = options.apiServer ?? makeServer();
  const interceptServer = options.interceptServer ?? makeServer();
  const routes = new Map();
  const apiApp = {
    listen: vi.fn((_port, _host, callback) => {
      callback?.();
      return apiServer;
    }),
  };
  const interceptApp = {
    get: vi.fn((path, handler) => {
      routes.set(path, handler);
      return interceptApp;
    }),
    listen: vi.fn((_port, _host, callback) => {
      callback?.();
      return interceptServer;
    }),
  };
  const prisma = {
    $connect: vi.fn(options.connectReject
      ? () => Promise.reject(options.connectReject)
      : () => Promise.resolve()),
    $disconnect: vi.fn(options.disconnectReject
      ? () => Promise.reject(options.disconnectReject)
      : () => Promise.resolve()),
    user: {
      count: vi.fn(options.countReject
        ? () => Promise.reject(options.countReject)
        : () => Promise.resolve(options.userCount ?? 1)),
    },
  };
  const mocks = {
    createSidecarApp: vi.fn(options.createSidecarApp ?? (() => apiApp)),
    express: vi.fn(() => interceptApp),
    initOpenCode: vi.fn(options.initReject
      ? () => Promise.reject(options.initReject)
      : () => Promise.resolve()),
    recoverActiveBatches: vi.fn(options.recoveryReject
      ? () => Promise.reject(options.recoveryReject)
      : () => Promise.resolve()),
    recoverInFlightExecutions: vi.fn(() => Promise.resolve()),
    registerShutdownHandlers: vi.fn(),
  };

  if (options.dotenvConfig || options.dotenvThrows) {
    vi.doMock('dotenv', () => {
      if (options.dotenvThrows) throw options.dotenvThrows;
      return { config: options.dotenvConfig };
    });
  }
  vi.doMock('express', () => ({ default: mocks.express }));
  vi.doMock('@openlinear/db', () => ({ prisma }));
  vi.doMock('@openlinear/api/logger', () => ({ logger }));
  vi.doMock('./app', () => ({ createSidecarApp: mocks.createSidecarApp }));
  vi.doMock('./services/opencode', () => ({
    initOpenCode: mocks.initOpenCode,
    registerShutdownHandlers: mocks.registerShutdownHandlers,
  }));
  vi.doMock('./services/execution/recovery', () => ({
    recoverActiveBatches: mocks.recoverActiveBatches,
    recoverInFlightExecutions: mocks.recoverInFlightExecutions,
  }));

  vi.spyOn(process, 'on').mockImplementation((event, handler) => {
    processHandlers.set(event, handler);
    return process;
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    exitCodes.push(code);
    return undefined;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  const module = await import('./index');
  return {
    apiApp,
    apiServer,
    exitCodes,
    interceptApp,
    interceptServer,
    logger,
    mocks,
    module,
    prisma,
    processHandlers,
    routes,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.unmock('dotenv');
  restoreEnv();
});

describe('sidecar entrypoint', () => {
  it('exports helpers without autostarting when disabled', async () => {
    const context = await loadIndex();

    expect(context.module.createSidecarApp).toBe(context.mocks.createSidecarApp);
    expect(context.module.start).toEqual(expect.any(Function));
    expect(context.mocks.createSidecarApp).not.toHaveBeenCalled();
    expect(context.mocks.registerShutdownHandlers).not.toHaveBeenCalled();
  });

  it('starts the API, redirects OAuth callbacks, recovers state, and initializes OpenCode', async () => {
    const context = await loadIndex({
      apiPort: '4321',
      bindHost: '0.0.0.0',
      frontendUrl: 'https://app.example.test',
      interceptorPort: '4322',
    });

    await context.module.start();

    expect(context.apiApp.listen).toHaveBeenCalledWith(4321, '0.0.0.0', expect.any(Function));
    expect(context.interceptApp.listen).toHaveBeenCalledWith(4322, '0.0.0.0', expect.any(Function));
    expect(context.mocks.registerShutdownHandlers).toHaveBeenCalledTimes(1);
    expect(context.prisma.$connect).toHaveBeenCalledTimes(1);
    expect(context.mocks.recoverInFlightExecutions).toHaveBeenCalledTimes(1);
    expect(context.mocks.recoverActiveBatches).toHaveBeenCalledTimes(1);
    expect(context.mocks.initOpenCode).toHaveBeenCalledTimes(1);

    const redirect = vi.fn();
    context.routes.get('/auth/callback')(
      { query: { code: 'abc', state: 'needs space' } },
      { redirect },
    );
    expect(redirect).toHaveBeenCalledWith(
      'https://app.example.test/auth/callback?code=abc&state=needs+space',
    );

    context.interceptServer.handlers.get('error')(new Error('busy'));
    expect(context.logger.warn).toHaveBeenCalledWith(
      { err: 'busy', port: 4322 },
      '[Sidecar] could not start OAuth Interceptor',
    );

    context.processHandlers.get('unhandledRejection')('reason');
    expect(context.logger.error).toHaveBeenCalledWith(
      { reason: 'reason' },
      '[Sidecar] unhandledRejection',
    );
  });

  it('uses default ports and frontend URL when env values are absent', async () => {
    const context = await loadIndex({
      apiPort: undefined,
      bindHost: undefined,
      frontendUrl: undefined,
      interceptorPort: undefined,
    });

    await context.module.start();

    expect(context.apiApp.listen).toHaveBeenCalledWith(3001, '127.0.0.1', expect.any(Function));
    expect(context.interceptApp.listen).toHaveBeenCalledWith(1455, '127.0.0.1', expect.any(Function));

    const redirect = vi.fn();
    context.routes.get('/auth/callback')({ query: { code: 'abc' } }, { redirect });
    expect(redirect).toHaveBeenCalledWith('http://localhost:3000/auth/callback?code=abc');
  });

  it('loads dotenv when enabled and ignores dotenv import failures', async () => {
    const dotenvConfig = vi.fn();
    const context = await loadIndex({ dotenvConfig, skipDotenv: '0' });

    await context.module.loadDotenvIfPresent();

    expect(dotenvConfig).toHaveBeenCalledWith({
      path: expect.stringContaining('.env'),
      quiet: true,
    });

    const missingDotenv = await loadIndex({
      dotenvThrows: new Error('missing dotenv'),
      skipDotenv: '0',
    });
    await expect(missingDotenv.module.loadDotenvIfPresent()).resolves.toBeUndefined();
  });

  it('closes servers across listening, already-closed, and close-error states', async () => {
    const context = await loadIndex();
    const notListening = makeServer({ listening: false });
    const alreadyClosed = makeServer({
      closeError: Object.assign(new Error('already closed'), { code: 'ERR_SERVER_NOT_RUNNING' }),
    });
    const closeFailedError = Object.assign(new Error('close failed'), { code: 'EFAIL' });
    const closeFailed = makeServer({
      closeError: closeFailedError,
    });

    await context.module.closeServer(notListening, 'closed');
    await context.module.closeServer(alreadyClosed, 'already closed');
    await context.module.closeServer(closeFailed, 'failed');

    expect(notListening.close).not.toHaveBeenCalled();
    expect(context.logger.error).toHaveBeenCalledWith(
      { err: closeFailedError },
      '[Sidecar] failed.close error',
    );
  });

  it('drains shutdown once and logs uncaught exceptions through the shutdown path', async () => {
    const context = await loadIndex();

    await context.module.start();

    context.processHandlers.get('SIGTERM')('SIGTERM');
    context.processHandlers.get('SIGTERM')('SIGTERM');
    await flushAsyncWork();

    expect(context.interceptServer.close).toHaveBeenCalledTimes(1);
    expect(context.apiServer.close).toHaveBeenCalledTimes(1);
    expect(context.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(context.exitCodes).toContain(0);

    const exceptionContext = await loadIndex();
    await exceptionContext.module.start();
    const error = new Error('uncaught');
    exceptionContext.processHandlers.get('uncaughtException')(error);
    await flushAsyncWork();

    expect(exceptionContext.logger.fatal).toHaveBeenCalledWith(
      { err: error },
      '[Sidecar] uncaughtException',
    );
    expect(exceptionContext.exitCodes).toContain(0);
  });

  it('logs shutdown failures and forced shutdown timeouts', async () => {
    const disconnectError = new Error('disconnect failed');
    const disconnectContext = await loadIndex({ disconnectReject: disconnectError });
    await disconnectContext.module.start();
    disconnectContext.processHandlers.get('SIGTERM')('SIGTERM');
    await flushAsyncWork();

    expect(disconnectContext.logger.error).toHaveBeenCalledWith(
      { err: disconnectError },
      '[Sidecar] prisma disconnect failed',
    );
    expect(disconnectContext.exitCodes).toContain(0);

    const closeError = new Error('close threw');
    const failingCloseServer = makeServer({
      close: () => {
        throw closeError;
      },
    });
    const failureContext = await loadIndex({ interceptServer: failingCloseServer });

    await failureContext.module.start();
    failureContext.processHandlers.get('SIGINT')('SIGINT');
    await flushAsyncWork();

    expect(failureContext.logger.error).toHaveBeenCalledWith(
      { err: closeError },
      '[Sidecar] graceful shutdown failed',
    );
    expect(failureContext.exitCodes).toContain(1);

    const hangingServer = makeServer({ close: () => undefined });
    const timeoutContext = await loadIndex({ interceptServer: hangingServer });
    const timeoutHandle = { unref: vi.fn() };
    let timeoutCallback;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback) => {
      timeoutCallback = callback;
      return timeoutHandle;
    });
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);

    await timeoutContext.module.start();
    timeoutContext.processHandlers.get('SIGTERM')('SIGTERM');
    timeoutCallback();

    expect(timeoutHandle.unref).toHaveBeenCalledTimes(1);
    expect(timeoutContext.logger.fatal).toHaveBeenCalledWith(
      '[Sidecar] graceful shutdown timed out — forcing exit',
    );
    expect(timeoutContext.exitCodes).toContain(1);
  });

  it('continues boot when recovery, user count, or OpenCode startup fails', async () => {
    const recoveryError = new Error('recover failed');
    const recoveryContext = await loadIndex({ recoveryReject: recoveryError });
    await recoveryContext.module.start();
    expect(recoveryContext.logger.error).toHaveBeenCalledWith(
      { err: recoveryError },
      '[Sidecar] recovery sweep failed (continuing boot)',
    );
    expect(recoveryContext.mocks.initOpenCode).toHaveBeenCalledTimes(1);

    const countError = new Error('count failed');
    const countContext = await loadIndex({ countReject: countError });
    await countContext.module.start();
    expect(countContext.logger.error).toHaveBeenCalledWith(
      { err: countError },
      '[Sidecar] Failed to count users for single-tenant guard (continuing)',
    );

    const opencodeError = new Error('opencode failed');
    const opencodeContext = await loadIndex({ initReject: opencodeError });
    await opencodeContext.module.start();
    expect(opencodeContext.logger.error).toHaveBeenCalledWith(
      { err: opencodeError },
      '[Sidecar] Failed to initialize OpenCode',
    );
    expect(opencodeContext.logger.warn).toHaveBeenCalledWith(
      '[Sidecar] Continuing without OpenCode — task execution will fail until restart',
    );
  });

  it('warns for acknowledged multi-user mode and exits for unacknowledged multi-user mode', async () => {
    const allowed = await loadIndex({ allowSharedOpenCode: true, userCount: 2 });
    await allowed.module.start();
    expect(allowed.logger.warn).toHaveBeenCalledWith(
      { userCount: 2 },
      '[Sidecar] Multi-user database with OPENLINEAR_ALLOW_SHARED_OPENCODE=1 — ' +
        'users WILL share OpenCode auth state. See docs/limitations.md.',
    );

    const blocked = await loadIndex({
      disconnectReject: new Error('disconnect during guard'),
      userCount: 2,
    });
    await blocked.module.start();
    expect(blocked.logger.fatal).toHaveBeenCalledWith(
      { userCount: 2 },
      '[Sidecar] Multi-user database detected but OpenCode runs in single-tenant mode. ' +
        'All users would share OpenCode provider credentials and sessions. ' +
        'Set OPENLINEAR_ALLOW_SHARED_OPENCODE=1 to acknowledge and proceed, ' +
        'or run one sidecar instance per user. See docs/limitations.md.',
    );
    expect(blocked.prisma.$disconnect).toHaveBeenCalledTimes(1);
    expect(blocked.exitCodes).toContain(2);
  });

  it('autostarts by default and reports fatal startup errors', async () => {
    const startupError = new Error('startup failed');
    const context = await loadIndex({
      defaultAutostart: true,
      createSidecarApp: () => {
        throw startupError;
      },
    });

    await vi.waitFor(() => {
      expect(context.logger.fatal).toHaveBeenCalledWith(
        { err: startupError },
        '[Sidecar] Fatal startup error',
      );
    });
    expect(context.exitCodes).toContain(1);
  });
});
