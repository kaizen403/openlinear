import type { PrismaClient } from '@openlinear/db';
import type { SidecarStore } from './store';

/**
 * The only doors from the sidecar to Prisma (development/test persistence and
 * the not-yet-migrated batch engine). Packaged builds replace this module with
 * `prisma-loader.packaged.ts` (see esbuild.config.js), so `@openlinear/db`
 * and the batch services are not even part of the shipped bundle.
 */
export async function loadPrismaStore(): Promise<SidecarStore> {
  const module = await import('./prisma-store');
  return module.createPrismaStore();
}

export async function loadPrismaClient(): Promise<PrismaClient> {
  const module = await import('@openlinear/db');
  return module.prisma;
}

export async function loadBatchServices() {
  return import('../services/batch');
}

export const PRISMA_PERSISTENCE_BUNDLED = true;
