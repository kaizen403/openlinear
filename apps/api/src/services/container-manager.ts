import Docker from 'dockerode';
import getPort from 'get-port';
import { createOpencodeClient, OpencodeClient } from '@opencode-ai/sdk';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { mkdirSync, accessSync, constants } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OPENCODE_IMAGE = process.env.OPENCODE_IMAGE || 'opencode-worker:latest';
const CONTAINER_PORT = 4096;
const CONTAINER_PREFIX = 'opencode-user-';
const PORT_RANGE_MIN = 30000;
const PORT_RANGE_MAX = 31000;
const CONTAINER_MEMORY = 512 * 1024 * 1024; // 512MB
const CONTAINER_CPU_SHARES = 512;
const IDLE_TIMEOUT_MS = parseInt(process.env.CONTAINER_IDLE_TIMEOUT_MS || String(2 * 60 * 60 * 1000), 10); // 2h default
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const HEALTH_CHECK_TIMEOUT_MS = 10_000;
const STARTUP_WAIT_MS = 8_000;
const MAX_STARTUP_RETRIES = 30;
const STARTUP_RETRY_DELAY_MS = 1_000;

// Path mapping between host and container filesystems.
// The host clones repos into HOST_REPOS_DIR; the container sees them at CONTAINER_REPOS_DIR
// via a bind mount. When passing `directory` to the OpenCode SDK we must use the container path.
const HOST_REPOS_DIR = process.env.REPOS_DIR || '/tmp/openlinear-repos';
const CONTAINER_REPOS_DIR = '/home/opencode/repos';

/**
 * Translate a host-side repo path to the equivalent container-side path.
 * E.g. /tmp/openlinear-repos/proj/abc → /home/opencode/repos/proj/abc
 */
export function toContainerPath(hostPath: string): string {
  if (hostPath.startsWith(HOST_REPOS_DIR)) {
    return hostPath.replace(HOST_REPOS_DIR, CONTAINER_REPOS_DIR);
  }
  return hostPath;
}

export interface UserContainer {
  containerId: string;
  userId: string;
  hostPort: number;
  baseUrl: string;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
  lastActivity: Date;
  createdAt: Date;
  error?: string;
}

const docker = new Docker({
  socketPath: process.env.DOCKER_HOST || '/var/run/docker.sock',
});

/** userId → container metadata */
const containers = new Map<string, UserContainer>();

/** Ports currently allocated */
const allocatedPorts = new Set<number>();

let cleanupInterval: NodeJS.Timeout | null = null;

// ---------------------------------------------------------------------------
// Port allocation
// ---------------------------------------------------------------------------

async function allocatePort(): Promise<number> {
  const port = await getPort({
    port: Array.from({ length: PORT_RANGE_MAX - PORT_RANGE_MIN }, (_, i) => PORT_RANGE_MIN + i),
    exclude: Array.from(allocatedPorts),
  });
  allocatedPorts.add(port);
  return port;
}

function releasePort(port: number): void {
  allocatedPorts.delete(port);
}

// ---------------------------------------------------------------------------
// Container name helper
// ---------------------------------------------------------------------------

function containerName(userId: string): string {
  return `${CONTAINER_PREFIX}${userId}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure a container is running for the given user.
 * Returns the container metadata (idempotent — won't create duplicates).
 */
export async function ensureContainer(userId: string): Promise<UserContainer> {
  // Fast path: already tracked and running
  const existing = containers.get(userId);
  if (existing && (existing.status === 'running' || existing.status === 'starting')) {
    existing.lastActivity = new Date();
    return existing;
  }

  // Check if a container already exists in Docker (e.g. after API restart)
  const recovered = await recoverExistingContainer(userId);
  if (recovered) {
    containers.set(userId, recovered);
    return recovered;
  }

  // Create new container
  return createContainer(userId);
}

/**
 * Create a fresh container for a user.
 */
async function createContainer(userId: string): Promise<UserContainer> {
  const hostPort = await allocatePort();
  const name = containerName(userId);
  const baseUrl = `http://127.0.0.1:${hostPort}`;

  const entry: UserContainer = {
    containerId: '',
    userId,
    hostPort,
    baseUrl,
    status: 'starting',
    lastActivity: new Date(),
    createdAt: new Date(),
  };
  containers.set(userId, entry);

  console.log(`[ContainerManager] Creating container ${name} on port ${hostPort}`);

  mkdirSync(HOST_REPOS_DIR, { recursive: true });

  try {
    const container = await docker.createContainer({
      name,
      Image: OPENCODE_IMAGE,
      Env: [
          `OPENCODE_PORT=${CONTAINER_PORT}`,
          `REPOS_DIR=${CONTAINER_REPOS_DIR}`,
        ],
      ExposedPorts: {
        [`${CONTAINER_PORT}/tcp`]: {},
      },
      HostConfig: {
        PortBindings: {
          [`${CONTAINER_PORT}/tcp`]: [{ HostPort: String(hostPort) }],
        },
        Memory: CONTAINER_MEMORY,
        CpuShares: CONTAINER_CPU_SHARES,
        PidsLimit: 256,
        // Named volumes for persistence
        Binds: [
            `opencode-auth-${userId}:/home/opencode/.local/share/opencode`,
            `opencode-config-${userId}:/home/opencode/.config/opencode`,
            `${HOST_REPOS_DIR}:${CONTAINER_REPOS_DIR}`,
          ],
        RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      },
      Labels: {
        'app': 'openlinear',
        'component': 'opencode-worker',
        'userId': userId,
      },
    });

    await container.start();
    entry.containerId = container.id;

    // Wait for the OpenCode server inside the container to be ready
    await waitForReady(baseUrl);

    entry.status = 'running';
    console.log(`[ContainerManager] Container ${name} running at ${baseUrl}`);
    return entry;
  } catch (err) {
    entry.status = 'error';
    entry.error = err instanceof Error ? err.message : 'Unknown error';
    releasePort(hostPort);
    console.error(`[ContainerManager] Failed to create container ${name}:`, entry.error);

    // Cleanup partial container
    try {
      const c = docker.getContainer(name);
      await c.stop().catch(() => {});
      await c.remove().catch(() => {});
    } catch { /* ignore */ }

    throw err;
  }
}

/**
 * Try to recover an existing Docker container for a user (e.g. after API restart).
 */
async function recoverExistingContainer(userId: string): Promise<UserContainer | null> {
  const name = containerName(userId);

  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();

    if (info.State.Running) {
      // Extract the mapped host port
      const portBindings = info.HostConfig.PortBindings?.[`${CONTAINER_PORT}/tcp`];
      const hostPort = portBindings?.[0]?.HostPort ? parseInt(portBindings[0].HostPort) : null;

      if (!hostPort) return null;

      allocatedPorts.add(hostPort);
      const baseUrl = `http://127.0.0.1:${hostPort}`;

      // Verify it's actually responding
      try {
        const client = createOpencodeClient({ baseUrl });
        await client.session.list();
      } catch {
        // Container exists but server not responding — remove and recreate
        console.log(`[ContainerManager] Stale container ${name} found, removing...`);
        await container.stop().catch(() => {});
        await container.remove().catch(() => {});
        releasePort(hostPort);
        return null;
      }

      console.log(`[ContainerManager] Recovered container ${name} on port ${hostPort}`);
      return {
        containerId: info.Id,
        userId,
        hostPort,
        baseUrl,
        status: 'running',
        lastActivity: new Date(),
        createdAt: new Date(info.Created),
      };
    }

    // Container exists but not running — remove it so we can recreate
    await container.remove({ force: true }).catch(() => {});
    return null;
  } catch {
    // Container doesn't exist
    return null;
  }
}

/**
 * Wait for the OpenCode server inside a container to become healthy.
 */
async function waitForReady(baseUrl: string): Promise<void> {
  for (let i = 0; i < MAX_STARTUP_RETRIES; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);

      const res = await fetch(`${baseUrl}/api/session`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, STARTUP_RETRY_DELAY_MS));
  }
  throw new Error(`OpenCode server at ${baseUrl} did not become ready in time`);
}

/**
 * Remove and destroy a user's container.
 */
export async function destroyContainer(userId: string): Promise<void> {
  const entry = containers.get(userId);
  const name = containerName(userId);

  console.log(`[ContainerManager] Destroying container ${name}`);

  try {
    const container = docker.getContainer(name);
    await container.stop({ t: 10 }).catch(() => {});
    await container.remove().catch(() => {});
  } catch (err: unknown) {
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode !== 404) {
      console.error(`[ContainerManager] Error destroying container ${name}:`, err);
    }
  }

  if (entry) {
    releasePort(entry.hostPort);
    containers.delete(userId);
  }
}

/**
 * Get a user's container status.
 */
export function getContainerStatus(userId: string): UserContainer | null {
  return containers.get(userId) ?? null;
}

/**
 * Get an OpencodeClient pointed at a user's container.
 * Optionally scoped to a specific directory.
 */
export async function getClientForUser(userId: string, directory?: string): Promise<OpencodeClient> {
  const entry = await ensureContainer(userId);

  if (entry.status !== 'running') {
    throw new Error(`Container for user ${userId} is not running (status: ${entry.status})`);
  }

  entry.lastActivity = new Date();

  const containerDir = directory ? toContainerPath(directory) : undefined;

  return createOpencodeClient({
    baseUrl: entry.baseUrl,
    ...(containerDir ? { directory: containerDir } : {}),
  });
}

/**
 * Record activity for a user's container (resets idle timer).
 */
export function touchContainer(userId: string): void {
  const entry = containers.get(userId);
  if (entry) {
    entry.lastActivity = new Date();
  }
}

/**
 * Check health of a user's container.
 */
export async function checkContainerHealth(userId: string): Promise<boolean> {
  const entry = containers.get(userId);
  if (!entry || entry.status !== 'running') return false;

  try {
    const client = createOpencodeClient({ baseUrl: entry.baseUrl });
    const response = await client.session.list();
    return !!response.data;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Idle cleanup
// ---------------------------------------------------------------------------

async function cleanupIdleContainers(): Promise<void> {
  const now = Date.now();

  for (const [userId, entry] of containers.entries()) {
    if (entry.status !== 'running') continue;

    const idle = now - entry.lastActivity.getTime();
    if (idle > IDLE_TIMEOUT_MS) {
      console.log(`[ContainerManager] Container for user ${userId} idle for ${Math.round(idle / 60_000)}m, destroying`);
      await destroyContainer(userId).catch(err => {
        console.error(`[ContainerManager] Cleanup error for ${userId}:`, err);
      });
    }
  }
}

/**
 * Discover and track any existing openlinear containers on startup.
 */
async function discoverExistingContainers(): Promise<void> {
  try {
    const existing = await docker.listContainers({
      all: true,
      filters: {
        label: ['app=openlinear', 'component=opencode-worker'],
      },
    });

    for (const info of existing) {
      const userId = info.Labels?.userId;
      if (!userId) continue;

      if (info.State === 'running') {
        const portBindings = info.Ports?.find(p => p.PrivatePort === CONTAINER_PORT);
        if (portBindings?.PublicPort) {
          const hostPort = portBindings.PublicPort;
          allocatedPorts.add(hostPort);
          containers.set(userId, {
            containerId: info.Id,
            userId,
            hostPort,
            baseUrl: `http://127.0.0.1:${hostPort}`,
            status: 'running',
            lastActivity: new Date(),
            createdAt: new Date(info.Created * 1000),
          });
          console.log(`[ContainerManager] Discovered running container for user ${userId} on port ${hostPort}`);
        }
      } else {
        // Clean up stopped containers
        try {
          const container = docker.getContainer(info.Id);
          await container.remove({ force: true });
          console.log(`[ContainerManager] Removed stopped container for user ${userId}`);
        } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.error('[ContainerManager] Failed to discover existing containers:', err);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Initialize the container manager. Call once on API startup.
 */
export async function initContainerManager(): Promise<void> {
  console.log('[ContainerManager] Initializing...');

  // Verify Docker connectivity
  try {
    await docker.ping();
    console.log('[ContainerManager] Docker daemon connected');
  } catch (err) {
    console.error('[ContainerManager] Cannot connect to Docker daemon:', err);
    console.error('[ContainerManager] Ensure Docker is running and the socket is accessible');
    return;
  }

  try {
    const images = await docker.listImages({
      filters: { reference: [OPENCODE_IMAGE] },
    });
    if (images.length === 0) {
      console.log('[ContainerManager] Worker image not found, building...');
      const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');
      execSync(`docker build -t ${OPENCODE_IMAGE} docker/opencode-worker/`, {
        cwd: projectRoot,
        stdio: 'inherit',
      });
      console.log('[ContainerManager] Worker image built successfully');
    } else {
      console.log(`[ContainerManager] Worker image ${OPENCODE_IMAGE} found`);
    }
  } catch (err) {
    console.error('[ContainerManager] Failed to build worker image:', err);
    console.error('[ContainerManager] Container creation will fail until image is available');
  }

  // Discover existing containers
  await discoverExistingContainers();

  // Start periodic idle cleanup
  cleanupInterval = setInterval(() => {
    cleanupIdleContainers().catch(console.error);
  }, CLEANUP_INTERVAL_MS);

  console.log(`[ContainerManager] Ready (idle timeout: ${Math.round(IDLE_TIMEOUT_MS / 60_000)}m)`);
}

/**
 * Shut down all managed containers gracefully.
 */
export async function shutdownContainerManager(): Promise<void> {
  console.log('[ContainerManager] Shutting down...');

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  // Stop all containers
  const destroyPromises = Array.from(containers.keys()).map(userId =>
    destroyContainer(userId).catch(err => {
      console.error(`[ContainerManager] Error destroying container for ${userId} on shutdown:`, err);
    })
  );
  await Promise.all(destroyPromises);

  console.log('[ContainerManager] Shut down complete');
}

/**
 * Get all tracked containers (for admin/debug).
 */
export function listContainers(): UserContainer[] {
  return Array.from(containers.values());
}
