import { broadcast } from '../sse';
import {
  initContainerManager,
  shutdownContainerManager,
  getClientForUser,
  getContainerStatus,
  listContainers,
  touchContainer,
  ensureContainer,
  destroyContainer,
  toContainerPath,
} from './container-manager';

export {
  getClientForUser,
  getContainerStatus,
  touchContainer,
  ensureContainer,
  destroyContainer,
  listContainers,
  toContainerPath,
};

export interface OpenCodeStatus {
  mode: 'container-per-user';
  activeContainers: number;
  containers: Array<{
    userId: string;
    status: string;
    hostPort: number;
    baseUrl: string;
    lastActivity: string;
    createdAt: string;
  }>;
}

export function getOpenCodeStatus(): OpenCodeStatus {
  const all = listContainers();
  return {
    mode: 'container-per-user',
    activeContainers: all.filter(c => c.status === 'running').length,
    containers: all.map(c => ({
      userId: c.userId,
      status: c.status,
      hostPort: c.hostPort,
      baseUrl: c.baseUrl,
      lastActivity: c.lastActivity.toISOString(),
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

export async function initOpenCode(): Promise<void> {
  try {
    await initContainerManager();
    broadcast('opencode:status', { status: 'ready', mode: 'container-per-user' });
    console.log('[OpenCode] Container-per-user mode ready');
  } catch (err) {
    console.error('[OpenCode] Failed to initialize container manager:', err);
    broadcast('opencode:status', { status: 'error', error: String(err) });
  }
}

export async function shutdownOpenCode(): Promise<void> {
  await shutdownContainerManager();
  broadcast('opencode:status', { status: 'stopped' });
}

export function registerShutdownHandlers(): void {
  const shutdown = async (signal: string) => {
    console.log(`[OpenCode] Received ${signal}, shutting down...`);
    await shutdownOpenCode();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('beforeExit', () => shutdownOpenCode());
}
