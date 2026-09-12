import { prisma, decryptToken } from '@openlinear/db';
import type { SidecarStore, TaskSnapshot } from './store';

export function createPrismaStore(): SidecarStore {
  return {
    async getTask(id) {
      const task = await prisma.task.findUnique({
        where: { id },
        include: {
          project: { include: { repository: true } },
          labels: { include: { label: true } },
        },
      });
      return task as unknown as TaskSnapshot | null;
    },
    async updateTask(id, data) {
      await prisma.task.update({ where: { id }, data: data as never });
    },
    async getScmToken(userId?: string) {
      if (!userId) return null;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { accessToken: true },
      });
      return decryptToken(user?.accessToken ?? null);
    },
    async getRepository(id) {
      const repo = await prisma.repository.findUnique({ where: { id } });
      if (!repo) return null;
      return {
        id: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        cloneUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
      };
    },
    async getActiveRepository() {
      const repo = await prisma.repository.findFirst({ where: { isActive: true } });
      if (!repo) return null;
      return {
        id: repo.id,
        name: repo.name,
        fullName: repo.fullName,
        cloneUrl: repo.cloneUrl,
        defaultBranch: repo.defaultBranch,
      };
    },
    async getSettings() {
      return prisma.settings.findFirst();
    },
    async createAgentRun(data) {
      const row = await prisma.agentRun.create({
        data: {
          taskId: data.taskId,
          agent: data.agent,
          model: data.model,
          runner: data.runner ?? data.agent,
          externalSessionId: data.externalSessionId ?? null,
          status: 'running',
        },
        select: { id: true },
      });
      return row;
    },
    async updateAgentRun(id, data) {
      await prisma.agentRun.update({ where: { id }, data: data as never });
    },
    async progress() {
      // Journal mirror is the API path; Prisma tests persist via AgentRunEvent in the API.
    },
  };
}

export { decryptToken };
