import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RunnerCapabilities } from '@openlinear/execution-core';
import { sidecarAppDataDir } from '../config/app-data';
import { getRunnerRegistry } from '../runners';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function modelsDevCachePath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return join(sidecarAppDataDir(env, platform), 'cache', 'models.dev.json');
}

export interface ModelCatalogueEntry {
  id: string;
  provider: string;
  name?: string;
  capabilities: RunnerCapabilities;
}

export async function loadModelsDevCatalogue(fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const path = modelsDevCachePath();
  if (existsSync(path)) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { fetchedAt: number; payload: unknown };
      if (Date.now() - raw.fetchedAt < CACHE_TTL_MS) return raw.payload;
    } catch {
      // refresh
    }
  }
  const res = await fetchImpl(MODELS_DEV_URL);
  if (!res.ok) throw new Error(`models.dev ${res.status}`);
  const payload = await res.json();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), payload }));
  return payload;
}

export async function listRunnerCatalogue(): Promise<ModelCatalogueEntry[]> {
  const entries: ModelCatalogueEntry[] = [];
  for (const runner of getRunnerRegistry().values()) {
    const models = await runner.listModels();
    for (const model of models) {
      entries.push({
        id: model.id,
        provider: model.provider,
        name: model.name,
        capabilities: runner.capabilities,
      });
    }
  }
  return entries;
}
