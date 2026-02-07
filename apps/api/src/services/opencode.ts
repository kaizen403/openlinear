import { createOpencode, createOpencodeClient, OpencodeClient } from '@opencode-ai/sdk';
import { broadcast } from '../sse';

const OPENCODE_PORT = parseInt(process.env.OPENCODE_PORT || '4096', 10);
const OPENCODE_HOST = process.env.OPENCODE_HOST || '127.0.0.1';
const OPENCODE_STARTUP_TIMEOUT = parseInt(process.env.OPENCODE_STARTUP_TIMEOUT || '30000', 10);
const HEALTH_CHECK_INTERVAL = 10000;
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 2000;

interface OpenCodeServerState {
  status: 'stopped' | 'starting' | 'running' | 'error';
  url: string | null;
  error: string | null;
  startedAt: Date | null;
}

let serverInstance: { url: string; close: () => void } | null = null;
let clientInstance: OpencodeClient | null = null;
let healthCheckInterval: NodeJS.Timeout | null = null;
let state: OpenCodeServerState = {
  status: 'stopped',
  url: null,
  error: null,
  startedAt: null,
};

export function getOpenCodeStatus(): OpenCodeServerState {
  return { ...state };
}

export function getClient(): OpencodeClient {
  if (!clientInstance) {
    throw new Error('OpenCode server is not running');
  }
  return clientInstance;
}

/**
 * Create a client scoped to a specific directory.
 * This is critical for task execution because OpenCode SDK is project-scoped.
 * Sessions created with a directory need a client that also references that directory
 * for events and operations to work correctly.
 */
export function getClientForDirectory(directory: string): OpencodeClient {
  const baseUrl = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`;
  return createOpencodeClient({ 
    baseUrl,
    directory,
  });
}

async function checkHealth(): Promise<boolean> {
  if (!clientInstance) return false;
  
  try {
    const response = await clientInstance.session.list();
    return !!response.data;
  } catch (error) {
    console.error('[OpenCode] Health check failed:', error);
    return false;
  }
}

function startHealthCheck(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
  }
  
  healthCheckInterval = setInterval(async () => {
    if (state.status !== 'running') return;
    
    const healthy = await checkHealth();
    if (!healthy) {
      console.warn('[OpenCode] Server unhealthy, attempting restart...');
      state.status = 'error';
      state.error = 'Health check failed';
      broadcast('opencode:status', { status: 'unhealthy' });
      
      await stopOpenCodeServer();
      await startOpenCodeServer();
    }
  }, HEALTH_CHECK_INTERVAL);
}

function stopHealthCheck(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

export async function startOpenCodeServer(): Promise<void> {
  if (state.status === 'running') {
    console.log('[OpenCode] Server already running');
    return;
  }
  
  if (state.status === 'starting') {
    console.log('[OpenCode] Server already starting');
    return;
  }
  
  state.status = 'starting';
  state.error = null;
  broadcast('opencode:status', { status: 'starting' });
  
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      console.log(`[OpenCode] Starting server (attempt ${attempt}/${MAX_RETRY_ATTEMPTS})...`);
      
      const { client, server } = await createOpencode({
        hostname: OPENCODE_HOST,
        port: OPENCODE_PORT,
        timeout: OPENCODE_STARTUP_TIMEOUT,
      });
      
      serverInstance = server;
      clientInstance = client;
      state = {
        status: 'running',
        url: server.url,
        error: null,
        startedAt: new Date(),
      };
      
      console.log(`[OpenCode] Server started at ${server.url}`);
      broadcast('opencode:status', { status: 'running', url: server.url });
      
      startHealthCheck();
      
      return;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[OpenCode] Failed to start (attempt ${attempt}):`, errorMessage);
      
      if (attempt < MAX_RETRY_ATTEMPTS) {
        console.log(`[OpenCode] Retrying in ${RETRY_DELAY}ms...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        state = {
          status: 'error',
          url: null,
          error: errorMessage,
          startedAt: null,
        };
        broadcast('opencode:status', { status: 'error', error: errorMessage });
        throw new Error(`Failed to start OpenCode server after ${MAX_RETRY_ATTEMPTS} attempts: ${errorMessage}`);
      }
    }
  }
}

export async function stopOpenCodeServer(): Promise<void> {
  stopHealthCheck();
  
  if (serverInstance) {
    console.log('[OpenCode] Stopping server...');
    try {
      serverInstance.close();
    } catch (error) {
      console.error('[OpenCode] Error stopping server:', error);
    }
    serverInstance = null;
  }
  
  clientInstance = null;
  state = {
    status: 'stopped',
    url: null,
    error: null,
    startedAt: null,
  };
  
  console.log('[OpenCode] Server stopped');
  broadcast('opencode:status', { status: 'stopped' });
}

export async function ensureOpenCodeServer(): Promise<void> {
  const existingUrl = `http://${OPENCODE_HOST}:${OPENCODE_PORT}`;
  
  try {
    console.log(`[OpenCode] Checking for existing server at ${existingUrl}...`);
    
    const testClient = createOpencodeClient({ baseUrl: existingUrl });
    const response = await testClient.session.list();
    
    if (response.data) {
      console.log('[OpenCode] Connected to existing server');
      clientInstance = testClient;
      state = {
        status: 'running',
        url: existingUrl,
        error: null,
        startedAt: new Date(),
      };
      broadcast('opencode:status', { status: 'running', url: existingUrl });
      startHealthCheck();
      return;
    }
  } catch {
    console.log('[OpenCode] No existing server found, starting new one...');
  }
  
  await startOpenCodeServer();
}

export function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`[OpenCode] Received ${signal}, shutting down...`);
    await stopOpenCodeServer();
    process.exit(0);
  };
  
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('beforeExit', () => stopOpenCodeServer());
}
