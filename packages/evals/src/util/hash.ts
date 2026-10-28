import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, readlink } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Deterministic JSON: object keys sorted, `undefined` members dropped, no
 * whitespace. Used for manifest digests and anything else that must hash the
 * same on every machine.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : sortValue(item)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member === undefined) continue;
      out[key] = sortValue(member);
    }
    return out;
  }
  return value;
}

export async function hashFile(path: string): Promise<string> {
  return sha256Hex(await readFile(path));
}

export interface TreeHashOptions {
  /** Relative POSIX paths for which this returns true are skipped (directories prune their subtree). */
  exclude?: (relativePath: string) => boolean;
}

/**
 * Content hash of a directory tree: every regular file and symlink, keyed by
 * its POSIX relative path, sorted. Modes other than the executable bit are
 * ignored so checkouts on different machines agree. `.git` is always skipped.
 */
export async function hashTree(root: string, options: TreeHashOptions = {}): Promise<string> {
  const entries: string[] = [];
  await walk(root, root, entries, options);
  entries.sort();
  return sha256Hex(entries.join('\n'));
}

async function walk(root: string, dir: string, out: string[], options: TreeHashOptions): Promise<void> {
  const names = (await readdir(dir)).sort();
  for (const name of names) {
    if (name === '.git') continue;
    const absolute = join(dir, name);
    const rel = relative(root, absolute).split(sep).join('/');
    if (options.exclude?.(rel)) continue;
    const info = await lstat(absolute);
    if (info.isDirectory()) {
      await walk(root, absolute, out, options);
    } else if (info.isSymbolicLink()) {
      out.push(`${rel}\0link\0${sha256Hex(await readlink(absolute))}`);
    } else if (info.isFile()) {
      const executable = (info.mode & 0o111) !== 0 ? 'x' : '-';
      out.push(`${rel}\0file${executable}\0${await hashFile(absolute)}`);
    }
  }
}
