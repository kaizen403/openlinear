import type { DiffFile, DiffFileStatus, DiffHunk, DiffLine, DiffLineKind, TaskDiffLimits } from './types';

/**
 * Pure parsing and bounding for the task review diff (no I/O).
 *
 * Inputs are git's own machine output for an agent-controlled worktree:
 * - the `diff --raw --numstat -z` listing (NUL-separated, paths verbatim);
 * - the `diff -p` patch text, split into per-file sections that are matched
 *   to the listing BY ORDER (same diffcore queue). Paths are never parsed out
 *   of patch headers; the header is only compared with the one git would
 *   print for the listing entry, to detect a misalignment.
 *
 * File content is untrusted text: lines are carried as plain strings and
 * never interpreted. CRLF: exactly one trailing '\r' is dropped from each
 * line's text (it is a line terminator, not content); any other '\r' and
 * every other byte are kept as they are. Invalid UTF-8 has already been
 * replaced with U+FFFD by the decoder.
 */

export const MAX_FILES = 300;
export const MAX_LINES_PER_FILE = 5_000;
export const MAX_TOTAL_LINES = 20_000;
export const MAX_LINE_CHARS = 1_000;
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_UNTRACKED_FILE_BYTES = 512 * 1024;
export const GIT_DIFF_TIMEOUT_MS = 20_000;

export const DEFAULT_DIFF_LIMITS: Readonly<TaskDiffLimits> = Object.freeze({
  maxFiles: MAX_FILES,
  maxLinesPerFile: MAX_LINES_PER_FILE,
  maxTotalLines: MAX_TOTAL_LINES,
  maxLineChars: MAX_LINE_CHARS,
  maxPatchBytes: MAX_PATCH_BYTES,
  maxUntrackedFileBytes: MAX_UNTRACKED_FILE_BYTES,
});

const LIMIT_KEYS: readonly (keyof TaskDiffLimits)[] = [
  'maxFiles',
  'maxLinesPerFile',
  'maxTotalLines',
  'maxLineChars',
  'maxPatchBytes',
  'maxUntrackedFileBytes',
];

/** Defaults with per-call overrides (tests); every limit is a positive safe integer. */
export function resolveDiffLimits(overrides: Partial<TaskDiffLimits> = {}): TaskDiffLimits {
  const limits: TaskDiffLimits = { ...DEFAULT_DIFF_LIMITS };
  for (const key of LIMIT_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid diff limit ${key}`);
    limits[key] = value;
  }
  return limits;
}

/** Global line budget shared by every file of one response. */
export interface LineBudget {
  remaining: number;
}

export function createLineBudget(limits: TaskDiffLimits): LineBudget {
  return { remaining: limits.maxTotalLines };
}

/** Lines already emitted for one file (shared across a typechange's two sections). */
export interface FileLineState {
  shown: number;
}

// ---------------------------------------------------------------------------
// Listing: `git diff --raw --numstat -z`
// ---------------------------------------------------------------------------

export interface ListingEntry {
  /** git status letter: A, C, D, M, R, T, U, X. */
  rawStatus: string;
  path: string;
  oldPath?: string;
  /** Similarity score of a rename/copy (0-100). */
  score?: number;
  oldMode: string;
  newMode: string;
  binary: boolean;
  additions: number;
  deletions: number;
  /** The listing was cut before this entry's numstat record. */
  countsUnknown?: true;
}

export interface ParsedListing {
  entries: ListingEntry[];
  /** The output was cut (buffer limit) or not understood past some point. */
  incomplete: boolean;
}

const RAW_RECORD_RE = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{4,64}) ([0-9a-f]{4,64}) ([A-Z])([0-9]{0,3})$/;
const NUMSTAT_RECORD_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

interface RawRecord {
  status: string;
  score?: number;
  oldMode: string;
  newMode: string;
  path: string;
  oldPath?: string;
}

interface NumstatRecord {
  added: string;
  deleted: string;
  path: string;
  oldPath?: string;
}

function count(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Parses the combined raw + numstat listing. Raw records come first
 * (`:oldmode newmode oldsha newsha STATUS\0path\0`, two paths for R/C),
 * numstat records after (`add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0`
 * for a rename/copy; `-\t-` for binary). Fields are consumed positionally,
 * so a path that looks like a record is never misread.
 *
 * A raw record with no numstat record is a stat-only change (`diff` runs with
 * `diff.autoRefreshIndex=false`, so it does not rewrite the agent's index):
 * the content is identical and git prints no numstat line and no patch
 * section for it, so it is dropped.
 */
export function parseListing(output: string, outputCut = false): ParsedListing {
  const fields = output.split('\0');
  const tail = fields.pop() ?? '';
  let incomplete = outputCut || tail !== '';
  const raws: RawRecord[] = [];
  const stats: NumstatRecord[] = [];
  let index = 0;
  while (index < fields.length) {
    const field = fields[index];
    const raw = RAW_RECORD_RE.exec(field);
    if (raw) {
      const status = raw[5];
      const twoPaths = status === 'R' || status === 'C';
      const needed = twoPaths ? 2 : 1;
      if (index + needed >= fields.length) {
        incomplete = true;
        break;
      }
      const record: RawRecord = { status, oldMode: raw[1], newMode: raw[2], path: twoPaths ? fields[index + 2] : fields[index + 1] };
      if (twoPaths) record.oldPath = fields[index + 1];
      if (raw[6] !== '') record.score = Math.min(100, count(raw[6]));
      raws.push(record);
      index += needed + 1;
      continue;
    }
    const stat = NUMSTAT_RECORD_RE.exec(field);
    if (stat) {
      if (stat[3] === '') {
        if (index + 2 >= fields.length) {
          incomplete = true;
          break;
        }
        stats.push({ added: stat[1], deleted: stat[2], oldPath: fields[index + 1], path: fields[index + 2] });
        index += 3;
      } else {
        stats.push({ added: stat[1], deleted: stat[2], path: stat[3] });
        index += 1;
      }
      continue;
    }
    // Not a record git prints: stop instead of guessing where paths are.
    incomplete = true;
    break;
  }

  const entries: ListingEntry[] = [];
  let next = 0;
  for (const raw of raws) {
    const base: ListingEntry = {
      rawStatus: raw.status,
      path: raw.path,
      oldMode: raw.oldMode,
      newMode: raw.newMode,
      binary: false,
      additions: 0,
      deletions: 0,
    };
    if (raw.oldPath !== undefined) base.oldPath = raw.oldPath;
    if (raw.score !== undefined) base.score = raw.score;
    const stat = stats[next];
    if (stat && stat.path === raw.path && stat.oldPath === raw.oldPath) {
      next += 1;
      const binary = stat.added === '-' || stat.deleted === '-';
      entries.push({ ...base, binary, additions: binary ? 0 : count(stat.added), deletions: binary ? 0 : count(stat.deleted) });
    } else if (incomplete && next >= stats.length) {
      entries.push({ ...base, countsUnknown: true });
    }
  }
  return { entries, incomplete };
}

export function fileStatusOf(entry: ListingEntry): DiffFileStatus {
  if (entry.binary) return 'binary';
  switch (entry.rawStatus) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    default:
      return 'modified';
  }
}

// ---------------------------------------------------------------------------
// Patch sections
// ---------------------------------------------------------------------------

export interface PatchSection {
  /** The `diff --git …` line, verbatim. */
  header: string;
  lines: string[];
}

/** Splits a patch on lines starting with `diff --git ` (content lines always carry a prefix). */
export function splitPatchSections(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: PatchSection | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = { header: line, lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  return sections;
}

const C_ESCAPES: Readonly<Record<number, string>> = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r', 34: '"', 92: '\\' };

function mustQuote(byte: number): boolean {
  return byte < 0x20 || byte === 0x22 || byte === 0x5c || byte >= 0x7f;
}

/**
 * git's `quote_c_style` of `prefix + name` with `core.quotePath=true` (which
 * the diff command forces): control bytes, '"', '\\', DEL and every byte
 * >= 0x80 make git quote the whole name.
 */
export function gitQuotedName(prefix: string, name: string): string {
  const bytes = Buffer.from(prefix + name, 'utf8');
  if (!bytes.some(mustQuote)) return prefix + name;
  let quoted = '"';
  for (const byte of bytes) {
    if (!mustQuote(byte)) quoted += String.fromCharCode(byte);
    else if (C_ESCAPES[byte] !== undefined) quoted += `\\${C_ESCAPES[byte]}`;
    else quoted += `\\${byte.toString(8).padStart(3, '0')}`;
  }
  return `${quoted}"`;
}

/**
 * The `diff --git` header git prints for an entry, or null when the path did
 * not survive UTF-8 decoding (U+FFFD) and so cannot be re-quoted exactly.
 */
export function expectedSectionHeader(entry: ListingEntry): string | null {
  const oldName = entry.oldPath ?? entry.path;
  if (oldName.includes('�') || entry.path.includes('�')) return null;
  return `diff --git ${gitQuotedName('a/', oldName)} ${gitQuotedName('b/', entry.path)}`;
}

function looksBinary(section: PatchSection): boolean {
  for (const line of section.lines) {
    if (line.startsWith('@@')) return false;
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') return true;
  }
  return false;
}

/** How far ahead to look for an entry's section after an unexpected header. */
const RESYNC_WINDOW = 64;

/**
 * Matches listing entries to patch sections by order. A typechange (T) has
 * two sections (deletion + creation); a binary entry whose content turned out
 * identical has none. Returns, per entry, the sections that belong to it.
 */
export function alignSections(entries: readonly ListingEntry[], sections: readonly PatchSection[]): PatchSection[][] {
  const aligned: PatchSection[][] = [];
  let cursor = 0;
  for (const entry of entries) {
    const wanted = entry.rawStatus === 'T' ? 2 : 1;
    const expected = expectedSectionHeader(entry);
    const taken: PatchSection[] = [];
    if (expected === null) {
      // Unverifiable path bytes: trust the order.
      if (entry.binary) {
        if (cursor < sections.length && looksBinary(sections[cursor])) taken.push(sections[cursor++]);
      } else {
        while (taken.length < wanted && cursor < sections.length) taken.push(sections[cursor++]);
      }
      aligned.push(taken);
      continue;
    }
    let at = cursor;
    if (!entry.binary && !(at < sections.length && sections[at].header === expected)) {
      const end = Math.min(sections.length, cursor + RESYNC_WINDOW);
      for (let probe = cursor + 1; probe < end; probe += 1) {
        if (sections[probe].header === expected) {
          at = probe;
          break;
        }
      }
    }
    while (taken.length < wanted && at < sections.length && sections[at].header === expected) taken.push(sections[at++]);
    if (taken.length > 0) cursor = at;
    aligned.push(taken);
  }
  return aligned;
}

// ---------------------------------------------------------------------------
// Hunks
// ---------------------------------------------------------------------------

export const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/** Cuts text at `max` UTF-16 units without splitting a surrogate pair. */
export function cutText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

function dropCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function safeNumber(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export interface SectionParseResult {
  hunks: DiffHunk[];
  /** A limit was hit or the section ended inside a hunk. */
  truncated: boolean;
}

/**
 * Parses the hunks of one file section, applying maxLineChars, the per-file
 * line cap (through `file`) and the global budget. Lines that are not part of
 * a hunk (extended headers, garbage, lines past a hunk's counts) are ignored.
 */
export function parseSectionHunks(
  lines: readonly string[],
  limits: TaskDiffLimits,
  budget: LineBudget,
  file: FileLineState = { shown: 0 },
): SectionParseResult {
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let remainingOld = 0;
  let remainingNew = 0;
  let last: DiffLine | null = null;
  let truncated = false;

  for (const rawLine of lines) {
    const line = dropCarriageReturn(rawLine);
    if (line.startsWith('@@')) {
      last = null;
      const match = HUNK_HEADER_RE.exec(line);
      const oldStart = match ? safeNumber(match[1], 0) : null;
      const oldLines = match ? safeNumber(match[2], 1) : null;
      const newStart = match ? safeNumber(match[3], 0) : null;
      const newLines = match ? safeNumber(match[4], 1) : null;
      if (oldStart === null || oldLines === null || newStart === null || newLines === null) {
        hunk = null;
        continue;
      }
      if (hunk && (remainingOld > 0 || remainingNew > 0)) truncated = true;
      if (file.shown >= limits.maxLinesPerFile || budget.remaining <= 0) {
        truncated = true;
        hunk = null;
        break;
      }
      hunk = { header: cutText(line, limits.maxLineChars).text, oldStart, oldLines, newStart, newLines, lines: [] };
      hunks.push(hunk);
      oldNo = oldStart;
      newNo = newStart;
      remainingOld = oldLines;
      remainingNew = newLines;
      continue;
    }
    if (!hunk) continue;
    const prefix = line.charAt(0);
    if (prefix === '\\') {
      if (last) last.noEol = true;
      last = null;
      continue;
    }
    let kind: DiffLineKind | null = null;
    if (prefix === ' ' && remainingOld > 0 && remainingNew > 0) kind = 'context';
    else if (prefix === '+' && remainingNew > 0) kind = 'add';
    else if (prefix === '-' && remainingOld > 0) kind = 'del';
    if (kind === null) {
      last = null;
      continue;
    }
    if (file.shown >= limits.maxLinesPerFile || budget.remaining <= 0) {
      truncated = true;
      break;
    }
    const { text, cut } = cutText(line.slice(1), limits.maxLineChars);
    let entry: DiffLine;
    if (kind === 'context') {
      entry = { kind, oldNo, newNo, text };
      oldNo += 1;
      newNo += 1;
      remainingOld -= 1;
      remainingNew -= 1;
    } else if (kind === 'add') {
      entry = { kind, newNo, text };
      newNo += 1;
      remainingNew -= 1;
    } else {
      entry = { kind, oldNo, text };
      oldNo += 1;
      remainingOld -= 1;
    }
    if (cut) entry.truncated = true;
    hunk.lines.push(entry);
    file.shown += 1;
    budget.remaining -= 1;
    last = entry;
  }
  if (!truncated && hunk && (remainingOld > 0 || remainingNew > 0)) truncated = true;
  return { hunks, truncated };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function fileFromEntry(entry: ListingEntry): DiffFile {
  const file: DiffFile = {
    path: entry.path,
    status: fileStatusOf(entry),
    additions: entry.additions,
    deletions: entry.deletions,
    hunks: [],
  };
  if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
  if (entry.score !== undefined && (entry.rawStatus === 'R' || entry.rawStatus === 'C')) file.similarity = entry.score;
  if (entry.countsUnknown) file.truncated = true;
  return file;
}

export interface TrackedAssembly {
  files: DiffFile[];
  /** Some shown file was cut (or its section is missing). */
  truncated: boolean;
}

/**
 * Builds the shown tracked files (at most `limits.maxFiles`) from the listing
 * and the patch text. `patchCut` means the patch output hit maxPatchBytes:
 * the last section is partial and later entries have none.
 */
export function assembleTrackedFiles(
  entries: readonly ListingEntry[],
  patch: string,
  patchCut: boolean,
  limits: TaskDiffLimits,
  budget: LineBudget,
): TrackedAssembly {
  const shown = entries.slice(0, limits.maxFiles);
  const sections = splitPatchSections(patch);
  const finalSection = sections.length > 0 ? sections[sections.length - 1] : null;
  const aligned = alignSections(shown, sections);
  const files: DiffFile[] = [];
  let truncated = false;
  shown.forEach((entry, index) => {
    const file = fileFromEntry(entry);
    const owned = aligned[index];
    if (!entry.binary) {
      if (owned.length === 0) {
        file.truncated = true;
      } else {
        const lineState: FileLineState = { shown: 0 };
        for (const section of owned) {
          const parsed = parseSectionHunks(section.lines, limits, budget, lineState);
          file.hunks.push(...parsed.hunks);
          if (parsed.truncated) file.truncated = true;
          if (patchCut && section === finalSection) file.truncated = true;
        }
      }
    }
    if (file.truncated) truncated = true;
    files.push(file);
  });
  return { files, truncated };
}

// ---------------------------------------------------------------------------
// Untracked files
// ---------------------------------------------------------------------------

export type UntrackedContent =
  | { kind: 'text'; text: string; cut: boolean }
  | { kind: 'binary' }
  | { kind: 'symlink'; target: string };

/**
 * A synthesized "new file" entry for an untracked path: one hunk
 * `@@ -0,0 +1,N @@` of `add` lines. A symlink's content is its target string
 * (what git records for mode 120000), without a trailing newline.
 */
export function buildUntrackedFile(path: string, content: UntrackedContent, limits: TaskDiffLimits, budget: LineBudget): DiffFile {
  if (content.kind === 'binary') {
    return { path, status: 'binary', additions: 0, deletions: 0, hunks: [], untracked: true };
  }
  let rows: string[];
  let noEol: boolean;
  let cut = false;
  if (content.kind === 'symlink') {
    rows = [content.target];
    noEol = true;
  } else {
    rows = content.text.split('\n');
    noEol = false;
    if (rows[rows.length - 1] === '') rows.pop();
    else if (!content.cut) noEol = true;
    cut = content.cut;
  }
  const file: DiffFile = { path, status: 'added', additions: rows.length, deletions: 0, hunks: [], untracked: true };
  const room = Math.max(0, Math.min(rows.length, limits.maxLinesPerFile, budget.remaining));
  if (room > 0) {
    const lines: DiffLine[] = [];
    for (let index = 0; index < room; index += 1) {
      const { text, cut: lineCut } = cutText(dropCarriageReturn(rows[index]), limits.maxLineChars);
      const line: DiffLine = { kind: 'add', newNo: index + 1, text };
      if (lineCut) line.truncated = true;
      lines.push(line);
    }
    if (noEol && room === rows.length) lines[room - 1].noEol = true;
    budget.remaining -= room;
    file.hunks.push({
      header: rows.length === 1 ? '@@ -0,0 +1 @@' : `@@ -0,0 +1,${rows.length} @@`,
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: rows.length,
      lines,
    });
  }
  if (cut || room < rows.length) file.truncated = true;
  return file;
}
