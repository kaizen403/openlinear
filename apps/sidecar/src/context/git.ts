import { spawn } from 'node:child_process';
import { buildHardenedGitEnv } from '../sandbox/git-hardening';
import { buildHardenedGitArgs, execGit } from '../services/git-credentials';

/**
 * W16b: the git reads behind the repository context index, all through the
 * sidecar's hardened git (no hooks, filters, helpers or user config; the
 * repository config is scanned before the first call, see execGit).
 *
 * Everything is read from the object database at one commit — never from a
 * working tree — so setup steps, an agent or uncommitted edits cannot change
 * what the index says about that commit. Every object read runs with
 * `GIT_NO_LAZY_FETCH=1`: in a blobless mirror an object that was never
 * materialised is reported missing (and the file indexed by path only)
 * instead of being fetched from the network. That is also why sizes come
 * from `cat-file --batch-check`, not `ls-tree -l` (which would fetch).
 */

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LS_TREE_MAX_BYTES = 64 * 1024 * 1024;

export function isCommitSha(value: string): boolean {
  return SHA_RE.test(value);
}

/** The full commit id `ref` names in `dir` (a commit SHA, `HEAD`, or a ref), or null. */
export async function resolveCommit(dir: string, ref: string): Promise<string | null> {
  if (!/^[A-Za-z0-9._/^{}-]+$/.test(ref) || ref.startsWith('-')) return null;
  try {
    const { stdout } = await execGit(['-C', dir, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
    const sha = stdout.trim();
    return isCommitSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

export class GitReadAborted extends Error {
  constructor(message = '[context] git read aborted') {
    super(message);
    this.name = 'GitReadAborted';
  }
}

/**
 * Runs one hardened git command in `dir` without lazy fetching, feeding
 * `input` on stdin and streaming stdout to `onData`. Killed on abort or when
 * stdout passes `maxBytes`.
 */
async function streamGit(
  dir: string,
  args: readonly string[],
  options: { input?: string; maxBytes?: number; signal?: AbortSignal; onData: (chunk: Buffer) => boolean | undefined },
): Promise<void> {
  if (options.signal?.aborted) throw new GitReadAborted();
  // execGit scans the repository config first and refuses an unsafe one; the
  // process below runs with the same hardened arguments and environment.
  await execGit(['-C', dir, 'rev-parse', '--git-dir']);
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', buildHardenedGitArgs(['-C', dir, ...args]), {
      env: buildHardenedGitEnv(undefined, process.env, { GIT_NO_LAZY_FETCH: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let settled = false;
    let bytes = 0;
    let stderr = '';
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(new GitReadAborted());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (options.maxBytes !== undefined && bytes > options.maxBytes) {
        finish(new Error('[context] git output too large'));
        return;
      }
      try {
        if (options.onData(chunk) === true) child.stdin.end();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`[context] git ${args[0] ?? ''} failed (${code}): ${stderr.split('\n')[0] ?? ''}`));
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

export interface TreeEntry {
  path: string;
  blob: string;
}

/**
 * Regular files of the commit's tree (`git ls-tree -r -z`): symlinks
 * (120000) and submodules (160000) are left out.
 */
export async function listTree(dir: string, commit: string, signal?: AbortSignal): Promise<TreeEntry[]> {
  if (!isCommitSha(commit)) throw new Error('[context] not a commit id');
  const chunks: Buffer[] = [];
  await streamGit(dir, ['ls-tree', '-r', '-z', '--full-tree', commit], {
    maxBytes: LS_TREE_MAX_BYTES,
    ...(signal ? { signal } : {}),
    onData: (chunk) => {
      chunks.push(chunk);
      return undefined;
    },
  });
  const entries: TreeEntry[] = [];
  for (const record of Buffer.concat(chunks).toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, object] = record.slice(0, tab).split(' ');
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !object || !isCommitSha(object)) continue;
    entries.push({ path: record.slice(tab + 1), blob: object });
  }
  return entries;
}

/** Sizes of the given blobs that are present locally (`cat-file --batch-check`); missing blobs are absent from the map. */
export async function blobSizes(dir: string, blobs: readonly string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const wanted = [...new Set(blobs.filter((blob) => isCommitSha(blob)))];
  const sizes = new Map<string, number>();
  if (wanted.length === 0) return sizes;
  let pending = '';
  const consume = (text: string) => {
    for (const line of text.split('\n')) {
      const [object, type, size] = line.split(' ');
      const bytes = Number(size);
      if (object && type === 'blob' && Number.isInteger(bytes) && bytes >= 0) sizes.set(object, bytes);
    }
  };
  await streamGit(dir, ['cat-file', '--batch-check'], {
    input: `${wanted.join('\n')}\n`,
    ...(signal ? { signal } : {}),
    onData: (chunk) => {
      pending += chunk.toString('utf8');
      const cut = pending.lastIndexOf('\n');
      if (cut !== -1) {
        consume(pending.slice(0, cut));
        pending = pending.slice(cut + 1);
      }
      return undefined;
    },
  });
  consume(pending);
  return sizes;
}

/**
 * Reads blobs through one `git cat-file --batch` process. `onBlob` receives
 * each requested blob in request order (null when missing).
 */
export async function readBlobs(
  dir: string,
  blobs: readonly string[],
  onBlob: (blob: string, content: Buffer | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  const wanted = blobs.filter((blob) => isCommitSha(blob));
  if (wanted.length === 0) return;
  let buffer: Buffer = Buffer.alloc(0);
  let next = 0;
  await streamGit(dir, ['cat-file', '--batch'], {
    input: `${wanted.join('\n')}\n`,
    ...(signal ? { signal } : {}),
    onData: (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      while (next < wanted.length) {
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) break;
        const parts = buffer.subarray(0, newline).toString('utf8').split(' ');
        const expected = wanted[next] ?? '';
        if (parts[1] === 'missing' || parts[1] === 'ambiguous') {
          buffer = buffer.subarray(newline + 1);
          next += 1;
          onBlob(expected, null);
          continue;
        }
        const size = Number(parts[2]);
        if (parts.length !== 3 || !Number.isInteger(size) || size < 0) throw new Error('[context] unexpected git cat-file output');
        if (buffer.length < newline + 1 + size + 1) break;
        const content = Buffer.from(buffer.subarray(newline + 1, newline + 1 + size));
        buffer = buffer.subarray(newline + 1 + size + 1);
        next += 1;
        onBlob(expected, parts[1] === 'blob' ? content : null);
      }
      return undefined;
    },
  });
  if (next < wanted.length) throw new Error('[context] git cat-file ended early');
}
