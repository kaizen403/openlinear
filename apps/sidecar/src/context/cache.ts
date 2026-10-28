import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { CONTEXT_INDEX_VERSION, type RepoIndex } from './repo-index';

/**
 * W16b: the on-disk cache of repository context indexes, under the sidecar's
 * app data (`<app data>/context-index`, which agent sandboxes cannot read).
 *
 * - One file per repository and commit: `<root>/<repo>/<commit>.json`, where
 *   `<repo>` is a hash of the repository identity. A commit's index never
 *   changes, so a new commit is a new entry (invalidation by SHA) and nothing
 *   is ever updated in place.
 * - Directories 0700, files 0600, written atomically (temp file + rename).
 *   A root that is a symlink or not owned by this user is not used at all.
 * - A file that does not parse or validate (wrong version, other commit) is
 *   deleted and the index rebuilt.
 * - Least recently used entries (file mtime, touched on every hit) are
 *   evicted beyond `maxEntries` or `maxBytes`.
 */

export const DEFAULT_CACHE_MAX_ENTRIES = 32;
export const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

const COMMIT_FILE = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\.json$/;
const REPO_DIR = /^[0-9a-f]{24}$/;

const blobSchema = z.object({
  lines: z.number().int().min(0),
  tokens: z.number().int().min(0),
  symbols: z.array(z.string()),
  terms: z.record(z.string(), z.number().int().positive()),
});

const indexSchema = z.object({
  version: z.literal(CONTEXT_INDEX_VERSION),
  commit: z.string(),
  builtAt: z.string(),
  files: z.array(z.object({
    path: z.string(),
    blob: z.string(),
    size: z.number().int().min(0),
    lang: z.string(),
    content: z.boolean(),
  })),
  blobs: z.record(z.string(), blobSchema),
  stats: z.object({
    tracked: z.number().int().min(0),
    indexed: z.number().int().min(0),
    withContent: z.number().int().min(0),
    reusedBlobs: z.number().int().min(0),
    bytesRead: z.number().int().min(0),
    missingBlobs: z.number().int().min(0),
    skipped: z.record(z.string(), z.number().int().min(0)),
  }),
});

/** Stable directory name for a repository identity (no path or name ever reaches the disk layout). */
export function repositoryDirName(repositoryKey: string): string {
  return createHash('sha256').update(`openlinear-context:${repositoryKey}`).digest('hex').slice(0, 24);
}

export interface ContextCacheOptions {
  root: string;
  maxEntries?: number;
  maxBytes?: number;
}

export class ContextIndexCache {
  readonly root: string;
  private readonly maxEntries: number;
  private readonly maxBytes: number;

  constructor(options: ContextCacheOptions) {
    this.root = options.root;
    this.maxEntries = options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  }

  pathFor(repositoryKey: string, commit: string): string {
    return join(this.root, repositoryDirName(repositoryKey), `${commit}.json`);
  }

  /** The cached index of `commit`, or null (missing, unreadable or invalid — the latter is deleted). */
  read(repositoryKey: string, commit: string): RepoIndex | null {
    if (!this.usableRoot(false)) return null;
    const path = this.pathFor(repositoryKey, commit);
    const index = this.load(path, commit);
    if (index) this.touch(path);
    return index;
  }

  /** The most recently used index of the repository other than `commit` (for blob reuse), or null. */
  latestFor(repositoryKey: string, exceptCommit: string): RepoIndex | null {
    if (!this.usableRoot(false)) return null;
    const dir = join(this.root, repositoryDirName(repositoryKey));
    const candidates: Array<{ path: string; commit: string; mtimeMs: number }> = [];
    try {
      for (const name of readdirSync(dir)) {
        const match = COMMIT_FILE.exec(name);
        if (!match || match[1] === exceptCommit) continue;
        const path = join(dir, name);
        const stat = lstatSync(path);
        if (stat.isFile()) candidates.push({ path, commit: match[1] ?? '', mtimeMs: stat.mtimeMs });
      }
    } catch {
      return null;
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.commit < b.commit ? -1 : 1));
    for (const candidate of candidates.slice(0, 2)) {
      const index = this.load(candidate.path, candidate.commit);
      if (index) return index;
    }
    return null;
  }

  /** Stores an index (atomic, owner-only), then evicts beyond the limits. Never throws. */
  write(repositoryKey: string, index: RepoIndex): void {
    try {
      if (!this.usableRoot(true)) return;
      const dir = join(this.root, repositoryDirName(repositoryKey));
      ensurePrivateDir(dir);
      const path = join(dir, `${index.commit}.json`);
      const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      writeFileSync(temp, JSON.stringify(index), { mode: 0o600, flag: 'wx' });
      renameSync(temp, path);
      this.evict();
    } catch (error) {
      logger.warn({ err: error }, '[context] could not write the repository context cache');
    }
  }

  /** Least recently used entries out until within maxEntries and maxBytes; stray temp files removed. */
  evict(): void {
    const entries: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const repo of names) {
      if (!REPO_DIR.test(repo)) continue;
      const dir = join(this.root, repo);
      let files: string[];
      try {
        if (!lstatSync(dir).isDirectory()) continue;
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of files) {
        const path = join(dir, name);
        try {
          const stat = lstatSync(path);
          if (!stat.isFile()) continue;
          if (name.endsWith('.tmp')) {
            if (Date.now() - stat.mtimeMs > 60 * 60 * 1000) rmSync(path, { force: true });
            continue;
          }
          if (COMMIT_FILE.test(name)) entries.push({ path, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // raced with another writer
        }
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1));
    let bytes = 0;
    entries.forEach((entry, position) => {
      bytes += entry.size;
      if (position >= this.maxEntries || bytes > this.maxBytes) rmSync(entry.path, { force: true });
    });
  }

  private load(path: string, commit: string): RepoIndex | null {
    let raw: string;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return null;
      raw = readFileSync(path, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = indexSchema.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.commit === commit) return parsed.data;
    } catch {
      // not JSON
    }
    logger.info({ commit: commit.slice(0, 12) }, '[context] cached index is unreadable or outdated; rebuilding');
    rmSync(path, { force: true });
    return null;
  }

  private touch(path: string): void {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      // best effort: LRU order only
    }
  }

  /** The root is a real directory owned by this user (created 0700 when `create`). */
  private usableRoot(create: boolean): boolean {
    try {
      if (create) ensurePrivateDir(this.root);
      const stat = lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      return uid === null || stat.uid === uid;
    } catch {
      return false;
    }
  }
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('[context] cache directory is not a directory');
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}
