import type { PrismaClient } from '@openlinear/db';
import type * as BatchServices from '../services/batch';
import type { SidecarStore } from './store';

/**
 * Packaged-build replacement for `prisma-loader.ts` (aliased by
 * esbuild.config.js when OPENLINEAR_PACKAGED=1). The shipped sidecar persists
 * only through the OpenLinear API; Prisma and the batch engine are absent.
 */
function unavailable(): Error {
  return new Error('Prisma persistence is not part of packaged sidecar builds; the sidecar persists through OPENLINEAR_API_URL');
}

export async function loadPrismaStore(): Promise<SidecarStore> {
  throw unavailable();
}

export async function loadPrismaClient(): Promise<PrismaClient> {
  throw unavailable();
}

export async function loadBatchServices(): Promise<typeof BatchServices> {
  throw unavailable();
}

export const PRISMA_PERSISTENCE_BUNDLED = false;
