/**
 * The fixture manifest: ids the benchmarks need plus freshly minted bench
 * credentials. Written OUTSIDE the repository (default
 * `$TMPDIR/openlinear-perf/`), mode 0600, because it holds bearer tokens and
 * the throwaway JWT secret the bench API runs with.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export interface BenchUser {
  id: string;
  username: string;
  workspaceRole: 'owner' | 'admin' | 'member' | 'viewer';
  accessToken: string;
}

export interface FixtureProjectRef {
  id: string;
  key: string;
  teamIds: string[];
  tasks: number;
}

export interface FixtureManifest {
  version: 1;
  seededAt: string;
  anchor: string;
  seed: number;
  database: string;
  counts: Record<string, number>;
  seedSeconds: number;
  workspaces: { primary: string; secondary: string; foreign: string };
  projects: { large: FixtureProjectRef; medium: FixtureProjectRef; small: FixtureProjectRef };
  /** A team on the large project; every bench user is a member. */
  teamId: string;
  benchUserIds: string[];
  /** 100 non-archived `todo` tasks of the large project for the bulk-status endpoint. */
  bulkMoveTaskIds: string[];
  /** A disjoint 100 for the per-task PATCH fan-out the board issues today. */
  fanoutMoveTaskIds: string[];
  detailTaskIds: string[];
  /** One chat session (with history) per bench user, keyed by user id. */
  chatSessions: Record<string, string>;
  search: { common: string; rare: string; identifier: string; none: string };
  credentials?: {
    mintedAt: string;
    jwtSecret: string;
    tokenEncryptionKey: string;
    users: BenchUser[];
    pat: { userId: string; token: string };
  };
}

export function perfOutDir(): string {
  return resolve(process.env.PERF_OUT_DIR ?? resolve(tmpdir(), 'openlinear-perf'));
}

export function manifestPath(databaseName: string): string {
  return resolve(perfOutDir(), `fixture-${databaseName}.json`);
}

export function writeManifest(databaseName: string, manifest: FixtureManifest): string {
  const dir = perfOutDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = manifestPath(databaseName);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function readManifest(databaseName: string): FixtureManifest {
  const path = manifestPath(databaseName);
  if (!existsSync(path)) {
    throw new Error(`No fixture manifest at ${path}. Run \`pnpm perf:seed\` first.`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest;
}
