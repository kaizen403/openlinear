import { extractSymbols, languageOf, looksBinary, MAX_INDEXED_FILE_BYTES, type SkipReason, skipReason } from './extract';
import { blobSizes, listTree, readBlobs, type TreeEntry } from './git';
import { countTerms, pathTerms, tokenize } from './tokenize';

/**
 * W16b: the repository context index of one commit.
 *
 * Built from the commit's tree (`git ls-tree`), so it is keyed by the commit
 * SHA and every file by its blob SHA (the content hash): the same commit
 * always yields the same index, and a blob already analysed for an earlier
 * commit of the repository is reused instead of read again. Per file: path,
 * blob, size, language; per blob: line count, token count, declared symbols
 * and its most frequent content terms.
 */

/** Bump when the analysis changes: cached indexes of other versions are rebuilt. */
export const CONTEXT_INDEX_VERSION = 1;
export const MAX_INDEX_FILES = 20_000;
/** Content read per build; files beyond it are indexed by path (and reused blobs) only. */
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
export const MAX_TERMS_PER_FILE = 400;

export interface IndexedBlob {
  lines: number;
  /** Content tokens in the file (length normalisation). */
  tokens: number;
  symbols: string[];
  /** The most frequent content terms (at most MAX_TERMS_PER_FILE) → frequency. */
  terms: Record<string, number>;
}

export interface IndexedFile {
  path: string;
  blob: string;
  size: number;
  lang: string;
  /** False: indexed by path only (blob missing from a partial clone, or over the content budget). */
  content: boolean;
}

export type IndexSkip = SkipReason | 'limit' | 'binary-content';

export interface RepoIndexStats {
  /** Regular files in the commit's tree. */
  tracked: number;
  indexed: number;
  withContent: number;
  /** Blobs analysed by an earlier build and reused. */
  reusedBlobs: number;
  bytesRead: number;
  /** Blobs a partial clone does not have locally (never fetched). */
  missingBlobs: number;
  skipped: Partial<Record<IndexSkip, number>>;
}

export interface RepoIndex {
  version: number;
  commit: string;
  builtAt: string;
  files: IndexedFile[];
  blobs: Record<string, IndexedBlob>;
  stats: RepoIndexStats;
}

/** Byte order, so the index does not depend on the locale. */
export function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Analysis of one text blob (pure). */
export function analyzeBlob(path: string, text: string): IndexedBlob {
  const lines = text.split(/\r?\n/);
  const symbols = extractSymbols(languageOf(path), lines).map((hit) => hit.name);
  const tokens = tokenize(text);
  const counts = [...countTerms(tokens)].sort((a, b) => b[1] - a[1] || comparePaths(a[0], b[0])).slice(0, MAX_TERMS_PER_FILE);
  counts.sort((a, b) => comparePaths(a[0], b[0]));
  return { lines: lines.length, tokens: tokens.length, symbols, terms: Object.fromEntries(counts) };
}

function bump(stats: RepoIndexStats, reason: IndexSkip): void {
  stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1;
}

export interface BuildIndexInput {
  /** A checkout or (bare) repository holding the commit's objects. */
  dir: string;
  commit: string;
  /** An earlier index of the same repository whose blob analyses may be reused. */
  previous?: RepoIndex | null;
  signal?: AbortSignal;
  now?: () => number;
  limits?: { maxFiles?: number; maxContentBytes?: number };
}

export async function buildRepoIndex(input: BuildIndexInput): Promise<RepoIndex> {
  const maxFiles = input.limits?.maxFiles ?? MAX_INDEX_FILES;
  const maxContentBytes = input.limits?.maxContentBytes ?? MAX_CONTENT_BYTES;
  const tree = (await listTree(input.dir, input.commit, input.signal)).sort((a, b) => comparePaths(a.path, b.path));
  const stats: RepoIndexStats = { tracked: tree.length, indexed: 0, withContent: 0, reusedBlobs: 0, bytesRead: 0, missingBlobs: 0, skipped: {} };
  const previous = input.previous?.version === CONTEXT_INDEX_VERSION ? input.previous.blobs : {};
  // Path rules first (no object access), then the sizes of what is left.
  const eligible: TreeEntry[] = [];
  for (const entry of tree) {
    const reason = skipReason(entry.path, 0);
    if (reason) {
      bump(stats, reason);
    } else if (eligible.length >= maxFiles) {
      bump(stats, 'limit');
    } else {
      eligible.push(entry);
    }
  }
  const sizes = await blobSizes(input.dir, eligible.map((entry) => entry.blob), input.signal);
  const blobs: Record<string, IndexedBlob> = {};
  const candidates: Array<{ path: string; blob: string; size: number }> = [];
  const toRead = new Set<string>();
  const missing = new Set<string>();
  let budget = maxContentBytes;
  for (const entry of eligible) {
    // Absent from the map: the blob is not in this (partial) clone.
    const size = sizes.get(entry.blob);
    if (size !== undefined && size > MAX_INDEXED_FILE_BYTES) {
      bump(stats, 'large');
      continue;
    }
    candidates.push({ ...entry, size: size ?? 0 });
    const reused = Object.hasOwn(previous, entry.blob) ? previous[entry.blob] : undefined;
    if (reused) {
      if (!blobs[entry.blob]) stats.reusedBlobs += 1;
      blobs[entry.blob] = reused;
    } else if (size === undefined) {
      missing.add(entry.blob);
    } else if (!toRead.has(entry.blob) && size <= budget) {
      toRead.add(entry.blob);
      budget -= size;
    }
  }
  stats.missingBlobs = missing.size;

  const binary = new Set<string>();
  const pathOf = new Map<string, string>();
  for (const entry of candidates) if (!pathOf.has(entry.blob)) pathOf.set(entry.blob, entry.path);
  await readBlobs(input.dir, [...toRead], (blob, content) => {
    if (!content) {
      stats.missingBlobs += 1;
      return;
    }
    stats.bytesRead += content.length;
    if (looksBinary(content)) {
      binary.add(blob);
      return;
    }
    blobs[blob] = analyzeBlob(pathOf.get(blob) ?? '', content.toString('utf8'));
  }, input.signal);

  const files: IndexedFile[] = [];
  for (const entry of candidates) {
    if (binary.has(entry.blob)) {
      bump(stats, 'binary-content');
      continue;
    }
    const content = Object.hasOwn(blobs, entry.blob);
    files.push({ path: entry.path, blob: entry.blob, size: entry.size, lang: languageOf(entry.path), content });
    if (content) stats.withContent += 1;
  }
  stats.indexed = files.length;
  const now = input.now ?? Date.now;
  return { version: CONTEXT_INDEX_VERSION, commit: input.commit, builtAt: new Date(now()).toISOString(), files, blobs, stats };
}

// ---------------------------------------------------------------------------
// Prepared form (in memory, for scoring)
// ---------------------------------------------------------------------------

export type ContextField = 'name' | 'dir' | 'symbols' | 'content';
export const CONTEXT_FIELDS: readonly ContextField[] = ['name', 'dir', 'symbols', 'content'];

export interface PreparedDoc {
  file: IndexedFile;
  pathLower: string;
  fields: Record<ContextField, ReadonlyMap<string, number>>;
  lengths: Record<ContextField, number>;
  symbols: readonly string[];
  lines: number | null;
}

export interface PreparedIndex {
  index: RepoIndex;
  docs: PreparedDoc[];
  averages: Record<ContextField, number>;
}

const EMPTY: ReadonlyMap<string, number> = new Map();

export function prepareIndex(index: RepoIndex): PreparedIndex {
  const totals: Record<ContextField, number> = { name: 0, dir: 0, symbols: 0, content: 0 };
  const docs = index.files.map((file): PreparedDoc => {
    const blob = file.content && Object.hasOwn(index.blobs, file.blob) ? index.blobs[file.blob] : undefined;
    const path = pathTerms(file.path);
    const symbolTerms = blob ? tokenize(blob.symbols.join(' ')) : [];
    const fields: Record<ContextField, ReadonlyMap<string, number>> = {
      name: countTerms(path.name),
      dir: countTerms(path.dir),
      symbols: symbolTerms.length > 0 ? countTerms(symbolTerms) : EMPTY,
      content: blob ? new Map(Object.entries(blob.terms)) : EMPTY,
    };
    const lengths: Record<ContextField, number> = { name: path.name.length, dir: path.dir.length, symbols: symbolTerms.length, content: blob?.tokens ?? 0 };
    for (const field of CONTEXT_FIELDS) totals[field] += lengths[field];
    return { file, pathLower: file.path.toLowerCase(), fields, lengths, symbols: blob?.symbols ?? [], lines: blob?.lines ?? null };
  });
  const count = Math.max(1, docs.length);
  const averages: Record<ContextField, number> = {
    name: Math.max(1, totals.name / count),
    dir: Math.max(1, totals.dir / count),
    symbols: Math.max(1, totals.symbols / count),
    content: Math.max(1, totals.content / count),
  };
  return { index, docs, averages };
}
