import type { OpenLinearClient } from '@openlinear/api-client';
import { shouldUsePrisma } from './boot';

export interface TaskSnapshot {
  id: string;
  title: string;
  description: string | null;
  model: string | null;
  agent: string | null;
  teamId: string | null;
  creatorId: string | null;
  workspaceId: string | null;
  projectId: string | null;
  project: {
    id: string;
    localPath: string | null;
    defaultAgent: string | null;
    repository: {
      id: string;
      name: string;
      fullName: string;
      cloneUrl: string;
      defaultBranch: string;
    } | null;
  } | null;
  labels: Array<{ taskId: string; labelId: string; label: { id: string; name: string; color: string } }>;
}

export interface SidecarStore {
  getTask(id: string): Promise<TaskSnapshot | null>;
  updateTask(id: string, data: Record<string, unknown>): Promise<void>;
  getScmToken(userId?: string): Promise<string | null>;
  getRepository(id: string): Promise<{ id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null>;
  getActiveRepository(): Promise<{ id: string; name: string; fullName: string; cloneUrl: string; defaultBranch: string } | null>;
  getSettings(): Promise<Record<string, unknown> | null>;
  createAgentRun(data: { taskId: string; agent: string; model: string; runner?: string; externalSessionId?: string }): Promise<{ id: string }>;
  updateAgentRun(id: string, data: Record<string, unknown>): Promise<void>;
  progress(runId: string, events: Array<{ seq: number; type: string; at?: string; payload?: unknown }>): Promise<void>;
}

export function createApiStore(client: OpenLinearClient): SidecarStore {
  return {
    async getTask(id) {
      return (await client.getTask(id)) as TaskSnapshot;
    },
    async updateTask(id, data) {
      await client.patchTaskExecution(id, data);
    },
    async getScmToken() {
      try {
        const res = await client.getScmToken();
        return res.token;
      } catch {
        return null;
      }
    },
    async getRepository(id) {
      return (await client.getRepository(id)) as Awaited<ReturnType<SidecarStore['getRepository']>>;
    },
    async getActiveRepository() {
      return (await client.getActiveRepository()) as Awaited<ReturnType<SidecarStore['getActiveRepository']>>;
    },
    async getSettings() {
      return (await client.getSettings()) as Record<string, unknown>;
    },
    async createAgentRun(data) {
      return client.createAgentRun(data);
    },
    async updateAgentRun(id, data) {
      await client.updateAgentRun(id, data);
    },
    async progress(runId, events) {
      await client.progress({ runId, events });
    },
  };
}

let override: SidecarStore | null = null;
let defaultClient: OpenLinearClient | null = null;

export function setSidecarStore(store: SidecarStore | null): void {
  override = store;
}

export function setDefaultApiClient(client: OpenLinearClient | null): void {
  defaultClient = client;
}

export function getDefaultApiClient(): OpenLinearClient | null {
  return defaultClient;
}

export async function getSidecarStore(client?: OpenLinearClient | null): Promise<SidecarStore> {
  if (override) return override;
  const resolved = client ?? defaultClient;
  if (resolved) return createApiStore(resolved);
  if (shouldUsePrisma()) {
    const { createPrismaStore } = await import('./prisma-store');
    return createPrismaStore();
  }
  throw new Error('Sidecar store requires an OpenLinearClient (no DATABASE_URL persistence)');
}
