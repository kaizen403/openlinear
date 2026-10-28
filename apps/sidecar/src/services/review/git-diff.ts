import { createHash, type Hash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { type FileHandle, lstat, open, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { HttpError, isHttpError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { GitConfigPolicyError } from '../../sandbox/git-hardening';
import { assertSafeRefName, execGit } from '../git-credentials';
import {
  GIT_DIFF_TIMEOUT_MS,
  assembleTrackedFiles,
  buildUntrackedFile,
  createLineBudget,
  parseListing,
  resolveDiffLimits,
  type UntrackedContent,
} from './diff-parser';
import type { DiffFile, TaskDiffLimits, TaskDiffResponse, TaskDiffSource } from './types';

/**
 * Computes the review diff of a task's attempt worktree: everything between
 * the base commit and the WORKING TREE (committed + staged + unstaged) plus
 * untracked files, bounded (diff-parser.ts) and fingerprinted.
 *
 * Security — the worktree is agent-controlled:
 * - every git call goes through `execGit` (hardened `-c` overrides, env
 *   allowlist with global/system config off, and the repository-config scan
 *   that refuses planted drivers/filters/helpers), and every call starts with
 *   `-C <worktree>` so that scan always runs;
 * - after execGit's prefix (which allows https for fetch/push) every network
 *   transport is re-disabled, so a blobless (`--filter=blob:none`) mirror can
 *   never lazy-fetch a missing blob from here;
 * - `--no-ext-diff --no-textconv` (no external diff / textconv programs),
 *   `--ignore-submodules=all`, `--no-color`, fixed `a/` `b/` prefixes and
 *   `core.quotePath=true` (deterministic headers for section alignment);
 * - `diff.autoRefreshIndex=false` + `--no-optional-locks`: by default
 *   `git diff` against the working tree rewrites `.git/index` when it finds
 *   stat-dirty entries (measured: `--no-optional-locks` alone does not stop
 *   it). That would take `index.lock` in the agent's worktree while the agent
 *   or the publication step (`git add`) may need it. With the refresh off git
 *   still lists stat-only entries in `--raw` (never in numstat or the patch);
 *   parseListing drops them.
 * - `.sisyphus/` runtime artifacts are excluded (publication never commits
 *   them);
 * - untracked files are read by the sidecar itself, never following a
 *   symlinked parent directory or final component (a symlink shows its target
 *   string, as git records it); FIFOs, sockets and devices are skipped.
 */

export const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';

/** Buffer for the raw+numstat listing (counts for every changed file). */
const LISTING_MAX_BUFFER = 32 * 1024 * 1024;
/** Buffer for the untracked path list. */
const UNTRACKED_LIST_MAX_BUFFER = 16 * 1024 * 1024;
/** Buffer for `rev-list` while looking for a fork point. */
const REV_LIST_MAX_BUFFER = 8 * 1024 * 1024;
const SMALL_MAX_BUFFER = 4 * 1024 * 1024;
/** Total untracked bytes read per response; past it files are listed without content. */
const MAX_UNTRACKED_TOTAL_BYTES = 16 * 1024 * 1024;
/** git treats a file as binary when its first 8000 bytes contain a NUL. */
const BINARY_SNIFF_BYTES = 8000;

const GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const USER_SHA_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const MAX_BASE_PARAM_CHARS = 255;

/** Network transports, re-disabled after execGit's hardened prefix. */
export const REVIEW_NETWORK_CONFIG: readonly string[] = [
  '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=never',
  '-c', 'protocol.git.allow=never',
  '-c', 'protocol.http.allow=never',
  '-c', 'protocol.https.allow=never',
  '-c', 'protocol.ssh.allow=never',
  '-c', 'protocol.ext.allow=never',
];

/** Read-only behaviour and deterministic output. */
export const REVIEW_READ_CONFIG: readonly string[] = [
  '-c', 'diff.autoRefreshIndex=false',
  '-c', 'core.quotePath=true',
];

export const DIFF_SAFETY_FLAGS: readonly string[] = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--ignore-submodules=all',
  '-M',
  '--relative',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

/** Everything under the worktree except runtime artifacts. */
export const REVIEW_PATHSPEC: readonly string[] = ['--', '.', ':(exclude).sisyphus'];

/** `git -C <worktree> --no-optional-locks <network off> <read-only> <args…>` (execGit adds its hardening ahead). */
export function buildReviewGitArgs(worktreePath: string, args: readonly string[]): string[] {
  return ['-C', worktreePath, '--no-optional-locks', ...REVIEW_NETWORK_CONFIG, ...REVIEW_READ_CONFIG, ...args];
}

export type DiffArgsMode = 'listing' | 'patch' | 'quiet';

/** The `git diff` argv for one of the three diff calls (base commit vs working tree). */
export function buildDiffArgs(worktreePath: string, baseSha: string, mode: DiffArgsMode): string[] {
  if (!GIT_SHA_RE.test(baseSha)) throw new Error('[TaskDiff] base must be a full object id');
  const format = mode === 'listing' ? ['--raw', '--numstat', '-z'] : mode === 'patch' ? ['-p', '--unified=3'] : ['--quiet'];
  return buildReviewGitArgs(worktreePath, ['diff', ...format, ...DIFF_SAFETY_FLAGS, baseSha, ...REVIEW_PATHSPEC]);
}

export function buildUntrackedArgs(worktreePath: string): string[] {
  return buildReviewGitArgs(worktreePath, ['ls-files', '--others', '--exclude-standard', '-z', ...REVIEW_PATHSPEC]);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function invalidBase(): HttpError {
  return new HttpError(400, 'INVALID_BASE_REF', 'base must be a branch/ref name or a full commit sha');
}

/** `?base=`: a safe ref name or a 40/64-hex sha; empty means "choose automatically". */
export function validateBaseParam(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_BASE_PARAM_CHARS) throw invalidBase();
  if (USER_SHA_RE.test(value)) return value.toLowerCase();
  try {
    return assertSafeRefName(value, 'base ref');
  } catch {
    throw invalidBase();
  }
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

/** Fields worth logging from a failed git process (never its stdout: that is worktree content). */
function describeGitFailure(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: String(error) };
  const summary: Record<string, unknown> = { name: error.name, message: error.message.split('\n')[0].slice(-300), code: errorCode(error) };
  if ('signal' in error) summary.signal = error.signal;
  if ('killed' in error) summary.killed = error.killed;
  if ('stderr' in error && typeof error.stderr === 'string') summary.stderr = error.stderr.slice(0, 2_000);
  return summary;
}

/** Maps any failure to the route's error envelope (no stderr, paths or config values in the body). */
export function toDiffHttpError(error: unknown): HttpError {
  if (isHttpError(error)) return error;
  if (error instanceof GitConfigPolicyError) {
    const message = error.keys.length > 0
      ? 'The task worktree has repository git configuration the sidecar refuses to run git with'
      : 'The task worktree git configuration could not be verified, so the sidecar refuses to run git there';
    return new HttpError(409, 'GIT_CONFIG_UNSAFE', message, { keys: [...error.keys] });
  }
  logger.error({ failure: describeGitFailure(error) }, '[TaskDiff] diff computation failed');
  return new HttpError(500, 'DIFF_FAILED', 'Failed to compute the task diff');
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

interface CappedOutput {
  stdout: string;
  /** maxBuffer was exceeded: stdout is a prefix of the real output. */
  cut: boolean;
}

/** git exited with a status (e.g. 1 = "not found" for rev-parse -q); not killed, not a policy refusal. */
function isExitStatusFailure(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof GitConfigPolicyError) return false;
  if ('killed' in error && error.killed === true) return false;
  return typeof errorCode(error) === 'number';
}

function exitStatusOf(error: unknown): number | null {
  const code = errorCode(error);
  return isExitStatusFailure(error) && typeof code === 'number' ? code : null;
}

class ReviewGit {
  constructor(readonly worktreePath: string, private readonly timeoutMs: number) {}

  async run(args: readonly string[], maxBuffer = SMALL_MAX_BUFFER): Promise<string> {
    const { stdout } = await execGit(args, { maxBuffer, timeout: this.timeoutMs });
    return stdout;
  }

  async capped(args: readonly string[], maxBuffer: number): Promise<CappedOutput> {
    try {
      return { stdout: await this.run(args, maxBuffer), cut: false };
    } catch (error) {
      if (errorCode(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        const partial = error instanceof Error && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
        return { stdout: partial, cut: true };
      }
      throw error;
    }
  }

  /** stdout (trimmed) or null when git exits non-zero; policy refusals, timeouts and spawn errors propagate. */
  async probe(args: readonly string[]): Promise<string | null> {
    try {
      return (await this.run(buildReviewGitArgs(this.worktreePath, args))).trim();
    } catch (error) {
      if (isExitStatusFailure(error)) return null;
      throw error;
    }
  }

  async commit(rev: string): Promise<string | null> {
    const out = await this.probe(['rev-parse', '--verify', '-q', '--end-of-options', `${rev}^{commit}`]);
    return out && GIT_SHA_RE.test(out) ? out : null;
  }

  async mergeBase(a: string, b: string): Promise<string | null> {
    const out = await this.probe(['merge-base', a, b]);
    const first = out?.split('\n')[0] ?? '';
    return GIT_SHA_RE.test(first) ? first : null;
  }

  /** `git diff --quiet`: false = no difference, true = differences. */
  async differs(baseSha: string): Promise<boolean> {
    try {
      await this.run(buildDiffArgs(this.worktreePath, baseSha, 'quiet'));
      return false;
    } catch (error) {
      if (exitStatusOf(error) === 1) return true;
      throw error;
    }
  }
}

function safeRefOrNull(ref: string | null | undefined): string | null {
  if (!ref) return null;
  try {
    return assertSafeRefName(ref);
  } catch {
    return null;
  }
}

async function emptyTreeSha(git: ReviewGit): Promise<string> {
  const format = await git.probe(['rev-parse', '--show-object-format']);
  return format === 'sha256' ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1;
}

/**
 * Parent of the oldest commit on HEAD that no remote-tracking ref contains
 * (task branches pushed back under `<remote>/openlinear/*` do not count).
 * Null when there is no usable remote ref or no such parent.
 */
async function forkPoint(git: ReviewGit, headSha: string): Promise<string | null> {
  const refs = await git.capped(buildReviewGitArgs(git.worktreePath, ['for-each-ref', '--format=%(refname)', 'refs/remotes']), SMALL_MAX_BUFFER);
  const usable = refs.stdout.split('\n').some((ref) => ref.startsWith('refs/remotes/') && !ref.slice('refs/remotes/'.length).includes('/openlinear/'));
  if (!usable) return null;
  const listed = await git.capped(
    buildReviewGitArgs(git.worktreePath, ['rev-list', '--topo-order', '--reverse', headSha, '--not', '--exclude=*/openlinear/*', '--remotes']),
    REV_LIST_MAX_BUFFER,
  );
  const oldest = listed.stdout.split('\n')[0]?.trim() ?? '';
  if (oldest === '') return listed.cut ? null : headSha;
  if (!GIT_SHA_RE.test(oldest)) return null;
  return git.commit(`${oldest}^`);
}

interface ChosenBase {
  ref: string;
  sha: string;
}

async function chooseBase(git: ReviewGit, headSha: string | null, requested: string | undefined, baseRef: string | null): Promise<ChosenBase> {
  if (requested !== undefined) {
    const commit = await git.commit(requested);
    if (!commit) throw new HttpError(404, 'BASE_REF_NOT_FOUND', 'The requested base does not resolve to a commit in the task worktree');
    const sha = headSha ? (await git.mergeBase(headSha, commit)) ?? commit : commit;
    return { ref: requested, sha };
  }
  if (!headSha) return { ref: 'empty', sha: await emptyTreeSha(git) };
  const branch = safeRefOrNull(baseRef);
  if (branch) {
    for (const [ref, label] of [[`refs/remotes/origin/${branch}`, `origin/${branch}`], [`refs/heads/${branch}`, branch]] as const) {
      const commit = await git.commit(ref);
      if (commit) return { ref: label, sha: (await git.mergeBase(headSha, commit)) ?? commit };
    }
  }
  const originHead = await git.commit('refs/remotes/origin/HEAD');
  if (originHead) return { ref: 'origin/HEAD', sha: (await git.mergeBase(headSha, originHead)) ?? originHead };
  const fork = await forkPoint(git, headSha);
  if (fork) return { ref: 'fork-point', sha: fork };
  return { ref: 'HEAD', sha: headSha };
}

// ---------------------------------------------------------------------------
// Untracked files
// ---------------------------------------------------------------------------

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function hasUnsafeSegment(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => segment === '..');
}

/** Drops an incomplete UTF-8 sequence left at the end of a cut buffer. */
function trimPartialUtf8(buffer: Buffer): Buffer {
  let index = buffer.length - 1;
  let continuation = 0;
  while (index >= 0 && continuation < 3 && (buffer[index] & 0xc0) === 0x80) {
    index -= 1;
    continuation += 1;
  }
  if (index < 0) return buffer;
  const lead = buffer[index];
  const needed = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return needed > continuation + 1 ? buffer.subarray(0, index) : buffer;
}

export interface UntrackedRead {
  content: UntrackedContent;
  /** Exact bytes read (for the revision fingerprint). */
  raw: Buffer;
}

async function parentIsReal(realWorktree: string, rel: string, full: string): Promise<boolean> {
  try {
    return (await realpath(dirname(full))) === resolve(realWorktree, dirname(rel));
  } catch {
    return false;
  }
}

/**
 * Reads one untracked path without following symlinks: the path must stay
 * inside the worktree and its parent directory must be the real directory it
 * names (no symlinked parent). Returns null for anything that is not a
 * regular file or a symlink, and for paths that vanish or fail checks.
 */
export async function readUntrackedPath(realWorktree: string, rel: string, maxBytes: number): Promise<UntrackedRead | null> {
  if (rel === '' || isAbsolute(rel) || hasUnsafeSegment(rel)) return null;
  const full = resolve(realWorktree, rel);
  if (!isInside(realWorktree, full)) return null;
  if (!(await parentIsReal(realWorktree, rel, full))) return null;
  let linkStat: Stats;
  try {
    linkStat = await lstat(full);
  } catch {
    return null;
  }
  if (linkStat.isSymbolicLink()) {
    try {
      const target = await readlink(full);
      return { content: { kind: 'symlink', target }, raw: Buffer.from(target, 'utf8') };
    } catch {
      return null;
    }
  }
  if (!linkStat.isFile()) return null;
  let handle: FileHandle;
  try {
    handle = await open(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== linkStat.dev || opened.ino !== linkStat.ino) return null;
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1));
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    // Narrow the window in which a parent could have been swapped for a symlink.
    if (!(await parentIsReal(realWorktree, rel, full))) return null;
    const raw = buffer.subarray(0, filled);
    if (raw.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return { content: { kind: 'binary' }, raw };
    const cut = filled > maxBytes;
    const text = (cut ? trimPartialUtf8(raw.subarray(0, maxBytes)) : raw).toString('utf8');
    return { content: { kind: 'text', text, cut }, raw };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Length-prefixed fingerprint input, so field boundaries are unambiguous. */
function frame(hash: Hash, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  hash.update(`${bytes.length}:`);
  hash.update(bytes);
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface ComputeTaskDiffInput {
  worktreePath: string;
  /** Default branch of the attempt's repository, when known. */
  baseRef: string | null;
  source: TaskDiffSource;
  /** Validated `?base=` value. */
  base?: string;
}

export interface ComputeTaskDiffOptions {
  limits?: Partial<TaskDiffLimits>;
  timeoutMs?: number;
}

async function computeUnmapped(input: ComputeTaskDiffInput, options: ComputeTaskDiffOptions): Promise<TaskDiffResponse> {
  const limits = resolveDiffLimits(options.limits);
  const requested = validateBaseParam(input.base);
  const worktree = input.worktreePath;
  if (!isAbsolute(worktree) || !(await realDirectory(worktree))) {
    throw new HttpError(404, 'DIFF_WORKSPACE_NOT_FOUND', 'The attempt worktree for this task no longer exists on this device');
  }
  const git = new ReviewGit(worktree, options.timeoutMs ?? GIT_DIFF_TIMEOUT_MS);

  const [headProbe, headRefProbe] = await Promise.all([
    git.probe(['rev-parse', '--verify', '-q', 'HEAD^{commit}']),
    git.probe(['symbolic-ref', '-q', '--short', 'HEAD']),
  ]);
  const headSha = headProbe && GIT_SHA_RE.test(headProbe) ? headProbe : null;
  const headRef = headRefProbe ? headRefProbe : null;
  const base = await chooseBase(git, headSha, requested, input.baseRef);

  const [listing, patch, untrackedList, trackedDirty] = await Promise.all([
    git.capped(buildDiffArgs(worktree, base.sha, 'listing'), LISTING_MAX_BUFFER),
    git.capped(buildDiffArgs(worktree, base.sha, 'patch'), limits.maxPatchBytes),
    git.capped(buildUntrackedArgs(worktree), UNTRACKED_LIST_MAX_BUFFER),
    headSha && headSha !== base.sha ? git.differs(headSha) : Promise.resolve(null),
  ]);

  const parsed = parseListing(listing.stdout, listing.cut);

  // The listing is fingerprinted in its parsed form: stat-only entries (a
  // touched but unchanged file) are dropped there and must not change it.
  const hash = createHash('sha256');
  frame(hash, 'openlinear-task-diff:v1');
  frame(hash, base.sha);
  frame(hash, headSha ?? '');
  frame(hash, JSON.stringify([parsed.incomplete, parsed.entries]));
  frame(hash, patch.stdout);
  frame(hash, untrackedList.stdout);

  const budget = createLineBudget(limits);
  const tracked = assembleTrackedFiles(parsed.entries, patch.stdout, patch.cut, limits, budget);
  const files: DiffFile[] = [...tracked.files];

  const names = untrackedList.stdout.split('\0');
  const partialName = names.pop() ?? '';
  const candidates = names.filter((name) => name.length > 0 && !name.endsWith('/'));
  let untrackedTruncated = untrackedList.cut || partialName !== '';
  let untrackedCount = candidates.length;
  let untrackedAdditions = 0;
  let untrackedBinary = 0;
  const slots = Math.max(0, limits.maxFiles - files.length);
  if (candidates.length > 0) {
    const realWorktree = await realpath(worktree);
    let shown = 0;
    let bytesLeft = MAX_UNTRACKED_TOTAL_BYTES;
    let index = 0;
    for (; index < candidates.length && shown < slots; index += 1) {
      const rel = candidates[index];
      if (bytesLeft <= 0) {
        files.push({ path: rel, status: 'added', additions: 0, deletions: 0, hunks: [], untracked: true, truncated: true });
        frame(hash, rel);
        shown += 1;
        untrackedTruncated = true;
        continue;
      }
      const read = await readUntrackedPath(realWorktree, rel, Math.min(limits.maxUntrackedFileBytes, bytesLeft));
      if (!read) {
        untrackedCount -= 1;
        continue;
      }
      bytesLeft -= read.raw.length;
      frame(hash, rel);
      frame(hash, read.content.kind);
      frame(hash, read.raw);
      const file = buildUntrackedFile(rel, read.content, limits, budget);
      if (file.status === 'binary') untrackedBinary += 1;
      untrackedAdditions += file.additions;
      if (file.truncated) untrackedTruncated = true;
      files.push(file);
      shown += 1;
    }
    if (index < candidates.length) untrackedTruncated = true;
  }

  // trackedDirty is null when base == HEAD (or there is no HEAD): then every
  // listed change is uncommitted.
  const dirty = untrackedCount > 0 || (trackedDirty ?? parsed.entries.length > 0);

  let additions = untrackedAdditions;
  let deletions = 0;
  let binaryFiles = untrackedBinary;
  for (const entry of parsed.entries) {
    additions += entry.additions;
    deletions += entry.deletions;
    if (entry.binary) binaryFiles += 1;
  }

  const truncated = parsed.incomplete
    || parsed.entries.length > limits.maxFiles
    || tracked.truncated
    || patch.cut
    || untrackedTruncated;

  return {
    base: { ref: base.ref, sha: base.sha },
    head: { ref: headRef, sha: headSha, dirty },
    revision: hash.digest('hex'),
    source: input.source,
    files,
    truncated,
    stats: {
      files: parsed.entries.length + untrackedCount,
      additions,
      deletions,
      shownFiles: files.length,
      binaryFiles,
      untrackedFiles: untrackedCount,
    },
    limits,
  };
}

/** Computes the bounded diff; every failure is an HttpError (see toDiffHttpError). */
export async function computeTaskDiff(input: ComputeTaskDiffInput, options: ComputeTaskDiffOptions = {}): Promise<TaskDiffResponse> {
  try {
    return await computeUnmapped(input, options);
  } catch (error) {
    throw toDiffHttpError(error);
  }
}
