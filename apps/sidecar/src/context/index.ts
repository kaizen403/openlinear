import { join } from 'node:path';
import { sidecarAppDataDir } from '../config/app-data';
import { logger } from '../lib/logger';
import { ContextIndexCache, repositoryDirName } from './cache';
import { isCommitSha, readBlobs, resolveCommit } from './git';
import { buildContextSection, DEFAULT_CONTEXT_MAX_CHARS } from './prompt';
import { buildRepoIndex, type PreparedIndex, prepareIndex, type RepoIndex } from './repo-index';
import { chooseExcerpt, type ContextQuery, parseQuery, rankFiles, reasonsFor, type RetrievalMode } from './retrieve';

/**
 * W16b — versioned repository context.
 *
 * `repositoryContextFor` gives a run's prompt a bounded "Repository context"
 * section: the files most related to the task (lexical BM25F over paths,
 * declared symbols and content terms), with short line-numbered excerpts,
 * from an index of the run's base commit. `findRelatedFiles` gives the same
 * ranking as citations (path, line range, reasons) for the desktop's
 * "Related files" (FE-11).
 *
 * The index is keyed by commit SHA and blob SHAs (repo-index.ts), cached on
 * disk per repository and commit (cache.ts), and kept in memory for the last
 * few commits. A build runs once per key at a time, one build at a time
 * process-wide, bounded to BUILD_HARD_LIMIT_MS; a caller waits at most its
 * own `timeoutMs` and otherwise gets "still indexing" while the build
 * finishes for the next call. Nothing here throws into a run: every failure
 * is a `null` section with a reason.
 */

export { DEFAULT_CONTEXT_MAX_CHARS } from './prompt';
export type { ContextQuery, RetrievalMode } from './retrieve';

export const REPO_CONTEXT_ENV = 'OPENLINEAR_REPO_CONTEXT';
export const REPO_CONTEXT_MAX_CHARS_ENV = 'OPENLINEAR_REPO_CONTEXT_MAX_CHARS';
const MIN_MAX_CHARS = 1_000;
const MAX_MAX_CHARS = 20_000;
export const DEFAULT_PROMPT_FILES = 6;
export const DEFAULT_EXCERPT_LINES = 14;
export const DEFAULT_PROMPT_TIMEOUT_MS = 20_000;
const BUILD_HARD_LIMIT_MS = 120_000;
/**
 * Prepared indexes kept in memory: the newest commit of at most this many
 * repositories (one each — a large repository's index takes hundreds of MB).
 */
const MEMO_ENTRIES = 3;
/** Files scoring below this share of the best score are not offered. */
const RELATIVE_CUTOFF = 0.25;

export interface RepositoryContextSettings {
  enabled: boolean;
  maxChars: number;
}

/**
 * `OPENLINEAR_REPO_CONTEXT=0|false|off|no` turns repository context off (the
 * prompt section and the related-files route); on by default.
 * `OPENLINEAR_REPO_CONTEXT_MAX_CHARS` (1000–20000, default 6000) bounds the
 * prompt section.
 */
export function repositoryContextSettings(env: NodeJS.ProcessEnv = process.env): RepositoryContextSettings {
  const raw = env[REPO_CONTEXT_ENV]?.trim().toLowerCase();
  const enabled = !raw || !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
  const chars = Number.parseInt(env[REPO_CONTEXT_MAX_CHARS_ENV] ?? '', 10);
  const maxChars = Number.isFinite(chars) ? Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, chars)) : DEFAULT_CONTEXT_MAX_CHARS;
  return { enabled, maxChars };
}

/**
 * The cache identity of a project's repository: the remote's full name, else
 * the local folder. Runs and the related-files route use the same key, so a
 * commit indexed by one is a cache hit for the other.
 */
export function repositoryKeyFor(source: { repository?: { fullName: string } | null; localPath?: string | null }): string | null {
  if (source.repository?.fullName) return `repo:${source.repository.fullName.toLowerCase()}`;
  if (source.localPath) return `local:${source.localPath}`;
  return null;
}

export interface ContextCitation {
  path: string;
  /** Null when the file is known by path only (no local copy of its content). */
  startLine: number | null;
  endLine: number | null;
  score: number;
  reasons: string[];
  /** Task words the file matched, strongest first. */
  matched: string[];
}

export interface ContextReceipt {
  /** The commit the index describes. */
  sha: string | null;
  indexedFiles: number;
  contentFiles: number;
  cacheHit: boolean;
  reusedBlobs: number;
  ms: number;
}

export type RelatedFilesStatus = 'ready' | 'indexing' | 'unavailable';

export interface RelatedFilesResult {
  status: RelatedFilesStatus;
  citations: ContextCitation[];
  /** Excerpt lines per citation (same order); null for path-only citations. */
  excerpts: Array<string[] | null>;
  receipt: ContextReceipt;
  /** Why there are no citations (null when there are). */
  reason: string | null;
}

export interface RelatedFilesInput {
  /** A checkout or repository with the commit's objects. */
  dir: string;
  /** The commit to index (a full SHA). */
  commit?: string | null;
  /** Without `commit`: the ref to resolve (default HEAD). */
  ref?: string;
  repositoryKey?: string | null;
  query: ContextQuery;
  limit?: number;
  excerptLines?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  mode?: RetrievalMode;
}

interface IndexHandle {
  prepared: PreparedIndex;
  cacheHit: boolean;
}

export interface ContextEngineOptions {
  /** null: no disk cache (memory only). Default `<app data>/context-index`. */
  cache?: ContextIndexCache | null;
  now?: () => number;
  buildHardLimitMs?: number;
}

export class ContextEngine {
  private readonly cache: ContextIndexCache | null;
  private readonly now: () => number;
  private readonly hardLimitMs: number;
  private readonly memo = new Map<string, PreparedIndex>();
  private readonly inFlight = new Map<string, Promise<IndexHandle>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ContextEngineOptions = {}) {
    this.cache = options.cache === undefined ? new ContextIndexCache({ root: join(sidecarAppDataDir(), 'context-index') }) : options.cache;
    this.now = options.now ?? Date.now;
    this.hardLimitMs = options.buildHardLimitMs ?? BUILD_HARD_LIMIT_MS;
  }

  /** Builds (or loads) the index of `commit` without searching it; resolves when it is ready. */
  async ensureIndex(dir: string, commit: string, repositoryKey: string | null): Promise<RepoIndex> {
    return (await this.indexFor(dir, commit, repositoryKey)).prepared.index;
  }

  async findRelated(input: RelatedFilesInput): Promise<RelatedFilesResult> {
    const started = this.now();
    const receipt = (sha: string | null, handle?: IndexHandle): ContextReceipt => ({
      sha,
      indexedFiles: handle?.prepared.index.stats.indexed ?? 0,
      contentFiles: handle?.prepared.index.stats.withContent ?? 0,
      cacheHit: handle?.cacheHit ?? false,
      reusedBlobs: handle?.prepared.index.stats.reusedBlobs ?? 0,
      ms: Math.max(0, this.now() - started),
    });
    const empty = (status: RelatedFilesStatus, reason: string, sha: string | null, handle?: IndexHandle): RelatedFilesResult => ({
      status, citations: [], excerpts: [], receipt: receipt(sha, handle), reason,
    });
    const requested = input.commit ?? input.ref ?? 'HEAD';
    if (input.commit && !isCommitSha(input.commit)) return empty('unavailable', 'not a commit id', null);
    const commit = await resolveCommit(input.dir, requested);
    if (!commit) return empty('unavailable', 'the repository or commit is not available on this device', null);
    if (input.signal?.aborted) return empty('unavailable', 'cancelled', commit);

    const key = input.repositoryKey ?? null;
    let handle: IndexHandle | 'timeout' | 'aborted';
    try {
      handle = await waitFor(this.indexFor(input.dir, commit, key), input.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS, input.signal);
    } catch {
      return empty('unavailable', 'the repository could not be indexed', commit);
    }
    if (handle === 'timeout') return empty('indexing', 'the repository is still being indexed', commit);
    if (handle === 'aborted') return empty('unavailable', 'cancelled', commit);

    const query = parseQuery(input.query);
    if (query.terms.length === 0 && query.mentions.length === 0) return empty('ready', 'the task has no searchable words', commit, handle);
    const ranked = rankFiles(handle.prepared, query, { mode: input.mode ?? 'full' });
    const top = ranked[0]?.score ?? 0;
    const picked = ranked.filter((entry) => entry.score >= top * RELATIVE_CUTOFF).slice(0, input.limit ?? DEFAULT_PROMPT_FILES);
    if (picked.length === 0) return empty('ready', 'no file in the repository shares words with the task', commit, handle);

    const contents = new Map<string, Buffer>();
    const wanted = [...new Set(picked.filter((entry) => entry.doc.file.content).map((entry) => entry.doc.file.blob))];
    try {
      await readBlobs(input.dir, wanted, (blob, content) => {
        if (content) contents.set(blob, content);
      }, input.signal);
    } catch (error) {
      logger.debug({ err: error }, '[context] excerpt read failed; citing paths only');
    }
    const citations: ContextCitation[] = [];
    const excerpts: Array<string[] | null> = [];
    for (const entry of picked) {
      const content = contents.get(entry.doc.file.blob);
      const terms = new Set(entry.matched.map((term) => term.term));
      const excerpt = content ? chooseExcerpt(content.toString('utf8'), entry.doc.file.lang, terms, input.excerptLines ?? DEFAULT_EXCERPT_LINES) : null;
      citations.push({
        path: entry.doc.file.path,
        startLine: excerpt?.startLine ?? null,
        endLine: excerpt?.endLine ?? null,
        score: Math.round(entry.score * 1000) / 1000,
        reasons: reasonsFor(entry),
        matched: [...new Set(entry.matched.map((term) => term.surface))].slice(0, 8),
      });
      excerpts.push(excerpt?.lines ?? null);
    }
    return { status: 'ready', citations, excerpts, receipt: receipt(commit, handle), reason: null };
  }

  /** The prepared index of `commit`: memory, then disk, then a (shared, queued) build. */
  private indexFor(dir: string, commit: string, repositoryKey: string | null): Promise<IndexHandle> {
    const group = repositoryKey ?? 'unkeyed';
    const memoKey = `${repositoryDirName(group)}:${commit}`;
    const memoized = this.memo.get(memoKey);
    if (memoized) {
      this.memo.delete(memoKey);
      this.memo.set(memoKey, memoized);
      return Promise.resolve({ prepared: memoized, cacheHit: true });
    }
    const pending = this.inFlight.get(memoKey);
    if (pending) return pending;
    const run = async (): Promise<IndexHandle> => {
      const cached = this.cache?.read(group, commit) ?? null;
      if (cached) return { prepared: this.remember(memoKey, prepareIndex(cached)), cacheHit: true };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.hardLimitMs);
      timer.unref?.();
      try {
        const previous = this.cache?.latestFor(group, commit) ?? null;
        const index = await buildRepoIndex({ dir, commit, previous, signal: controller.signal, now: this.now });
        // An index built while blobs were missing (partial clone) is used but
        // not persisted, so a later build with the content replaces it.
        if (index.stats.missingBlobs === 0) this.cache?.write(group, index);
        return { prepared: this.remember(memoKey, prepareIndex(index)), cacheHit: false };
      } finally {
        clearTimeout(timer);
      }
    };
    const queued = this.queue.then(run, run);
    this.queue = queued.catch(() => undefined);
    const shared = queued.finally(() => this.inFlight.delete(memoKey));
    shared.catch((error: unknown) => logger.warn({ err: error, commit: commit.slice(0, 12) }, '[context] repository index build failed'));
    this.inFlight.set(memoKey, shared);
    return shared;
  }

  private remember(key: string, prepared: PreparedIndex): PreparedIndex {
    // One commit per repository: an older commit's index of the same repository goes.
    const repository = key.slice(0, key.lastIndexOf(':') + 1);
    for (const existing of [...this.memo.keys()]) if (existing !== key && existing.startsWith(repository)) this.memo.delete(existing);
    this.memo.set(key, prepared);
    while (this.memo.size > MEMO_ENTRIES) {
      const oldest = this.memo.keys().next().value;
      if (oldest === undefined) break;
      this.memo.delete(oldest);
    }
    return prepared;
  }
}

async function waitFor<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T | 'timeout' | 'aborted'> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
        timer.unref?.();
      }),
      new Promise<'aborted'>((resolve) => {
        if (!signal) return;
        if (signal.aborted) resolve('aborted');
        onAbort = () => resolve('aborted');
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

let defaultEngine: ContextEngine | null = null;

/** The process-wide engine (disk cache under the sidecar's app data). */
export function defaultContextEngine(): ContextEngine {
  if (!defaultEngine) defaultEngine = new ContextEngine();
  return defaultEngine;
}

/** Tests: replace (or reset with null) the process-wide engine. */
export function setDefaultContextEngineForTests(engine: ContextEngine | null): void {
  defaultEngine = engine;
}

// ---------------------------------------------------------------------------
// The run prompt
// ---------------------------------------------------------------------------

export interface RepositoryContextInput {
  /** The run's worktree (its objects are read; its files are not). */
  worktreePath: string;
  /** The run's base commit (`workspace.baseCommit`); HEAD when null. */
  commitSha?: string | null;
  /** `repositoryKeyFor(snapshot)`: shares the cache with the related-files route. */
  repositoryKey?: string | null;
  task: { title: string; description?: string | null; labels?: readonly string[] };
  maxChars?: number;
  maxFiles?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Default: the process-wide engine. */
  engine?: ContextEngine;
}

export interface RepositoryContextResult {
  /** The prompt section, or null (nothing related, disabled, unavailable, too slow, failed). */
  section: string | null;
  /** What the section shows: excerpts with the lines shown, then files listed by path. */
  citations: ContextCitation[];
  receipt: ContextReceipt;
  /** Why there is no section (null when there is one). */
  reason: string | null;
}

/** The bounded "Repository context" prompt section for a task (never throws). */
export async function repositoryContextFor(input: RepositoryContextInput): Promise<RepositoryContextResult> {
  const started = Date.now();
  const none = (reason: string, receipt?: ContextReceipt): RepositoryContextResult => ({
    section: null,
    citations: [],
    receipt: receipt ?? { sha: null, indexedFiles: 0, contentFiles: 0, cacheHit: false, reusedBlobs: 0, ms: Date.now() - started },
    reason,
  });
  try {
    const engine = input.engine ?? defaultContextEngine();
    const related = await engine.findRelated({
      dir: input.worktreePath,
      commit: input.commitSha ?? null,
      repositoryKey: input.repositoryKey ?? null,
      query: { title: input.task.title, description: input.task.description ?? null, labels: input.task.labels ?? [] },
      limit: input.maxFiles ?? DEFAULT_PROMPT_FILES,
      timeoutMs: input.timeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (related.citations.length === 0 || !related.receipt.sha) return none(related.reason ?? 'nothing related was found', related.receipt);
    const excerpts = related.citations.flatMap((citation, index) => {
      const lines = related.excerpts[index];
      return lines && citation.startLine !== null && citation.endLine !== null
        ? [{ path: citation.path, startLine: citation.startLine, endLine: citation.endLine, lines, matched: citation.matched }]
        : [];
    });
    const pathOnly = related.citations.filter((_citation, index) => !related.excerpts[index]).map((citation) => citation.path);
    const built = buildContextSection({ commit: related.receipt.sha, excerpts, extraPaths: pathOnly, maxChars: input.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS });
    if (!built.section) return none('the related files did not fit the context budget', related.receipt);
    const byPath = new Map(related.citations.map((citation) => [citation.path, citation]));
    const citations: ContextCitation[] = [];
    for (const shown of built.shown) {
      const citation = byPath.get(shown.path);
      if (citation) citations.push({ ...citation, startLine: shown.startLine, endLine: shown.endLine });
    }
    for (const path of built.listed) {
      const citation = byPath.get(path);
      if (citation) citations.push({ ...citation, startLine: null, endLine: null });
    }
    return { section: built.section, citations, receipt: related.receipt, reason: null };
  } catch (error) {
    logger.warn({ err: error }, '[context] repository context failed; the prompt goes without it');
    return none(`repository context failed: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown error'}`);
  }
}

/** One log line for the run's activity: what was added to the prompt, or why nothing was. */
export function describeContextReceipt(result: RepositoryContextResult): string {
  const { receipt } = result;
  if (!result.section) return `Repository context: none (${result.reason ?? 'nothing related was found'})`;
  const files = result.citations.length;
  const at = receipt.sha ? ` at ${receipt.sha.slice(0, 12)}` : '';
  return `Repository context: ${files} related file${files === 1 ? '' : 's'}${at} (${receipt.cacheHit ? 'cached index' : 'indexed'} ${receipt.indexedFiles} files, ${receipt.ms} ms)`;
}
