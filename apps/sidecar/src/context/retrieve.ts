import { extractSymbols, isTrivialLine } from './extract';
import { comparePaths, type ContextField, type PreparedDoc, type PreparedIndex } from './repo-index';
import { pathMentions, queryTerms, tokenize } from './tokenize';

/**
 * W16b: lexical retrieval over a prepared index — BM25 per field (file name,
 * directory, declared symbols, content terms), each field saturated on its
 * own and then weighted, so a term in a file's name or declarations counts
 * more than any number of mentions in its text. The task's title weighs
 * more than its description; a file the task names by path gets a fixed
 * bonus; tests and documents are ranked below source files unless the task
 * is about them. Deterministic: ties break on the path.
 *
 * `mode` exists for the ablation (docs/reports/revamp-2026-10-26/context.md):
 * `path` scores only the path fields, `path+symbols` adds declared symbols,
 * `full` (production) adds content terms.
 *
 * Pure: no I/O.
 */

export type RetrievalMode = 'path' | 'path+symbols' | 'full';

export interface ContextQuery {
  title: string;
  description?: string | null;
  labels?: readonly string[];
}

const K1 = 1.2;
const FIELD_WEIGHT: Readonly<Record<ContextField, number>> = { name: 2, dir: 0.6, symbols: 1.2, content: 1 };
const FIELD_B: Readonly<Record<ContextField, number>> = { name: 0.3, dir: 0.5, symbols: 0.5, content: 0.75 };
/** Score multipliers for tests and prose, unless the task mentions them. */
const TEST_PRIOR = 0.5;
const DOC_PRIOR = 0.6;
const TEST_PATH = /(?:^|\/)(?:__tests__|__mocks__|tests?|spec|specs|fixtures|e2e)\/|\.(?:test|spec|bench|e2e|realgit|integration)\.[A-Za-z0-9.]+$|_test\.(?:go|py|rb|rs)$|(?:^|\/)test_[^/]*\.py$/;
const DOC_LANGUAGES = new Set(['markdown', 'text']);
const MODE_FIELDS: Readonly<Record<RetrievalMode, readonly ContextField[]>> = {
  path: ['name', 'dir'],
  'path+symbols': ['name', 'dir', 'symbols'],
  full: ['name', 'dir', 'symbols', 'content'],
};
const MAX_QUERY_TERMS = 48;
const MAX_QUERY_CHARS = 8_000;
const PATH_MENTION_BONUS = 8;

export interface WeightedTerm {
  term: string;
  surface: string;
  weight: number;
}

export interface ParsedQuery {
  terms: WeightedTerm[];
  mentions: string[];
  /** The task is about tests / documentation (their priors do not apply). */
  wantsTests: boolean;
  wantsDocs: boolean;
}

/** Title terms count twice; repeats saturate (√, at most 2); at most MAX_QUERY_TERMS distinct terms. */
export function parseQuery(query: ContextQuery): ParsedQuery {
  const title = query.title.slice(0, 500);
  const body = (query.description ?? '').slice(0, MAX_QUERY_CHARS);
  const labels = (query.labels ?? []).join(' ').slice(0, 500);
  const counts = new Map<string, { surface: string; count: number; order: number }>();
  let order = 0;
  const add = (text: string, factor: number) => {
    for (const { term, surface } of queryTerms(text)) {
      const current = counts.get(term);
      if (current) current.count += factor;
      else counts.set(term, { surface, count: factor, order: order++ });
    }
  };
  add(title, 2);
  add(body, 1);
  add(labels, 1);
  const terms = [...counts]
    .map(([term, value]) => ({ term, surface: value.surface, weight: Math.sqrt(Math.min(4, value.count)), order: value.order }))
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .slice(0, MAX_QUERY_TERMS)
    .map(({ term, surface, weight }) => ({ term, surface, weight }));
  const text = `${title}\n${body}\n${labels}`;
  return {
    terms,
    mentions: pathMentions(`${title}\n${body}`),
    wantsTests: /\b(?:tests?|testing|specs?|coverage|fixtures?|e2e)\b/i.test(text),
    wantsDocs: /\b(?:docs?|documentation|readme|guide|ledger|reports?|changelog|markdown)\b/i.test(text),
  };
}

/** The ranking prior of a file for this query: 1, or less for tests and prose. */
export function filePrior(doc: PreparedDoc, query: Pick<ParsedQuery, 'wantsTests' | 'wantsDocs'>): number {
  if (!query.wantsTests && TEST_PATH.test(doc.file.path)) return TEST_PRIOR;
  if (!query.wantsDocs && DOC_LANGUAGES.has(doc.file.lang)) return DOC_PRIOR;
  return 1;
}

export interface RankedFile {
  doc: PreparedDoc;
  score: number;
  /** Matched query terms, strongest first. */
  matched: WeightedTerm[];
  /** Matched terms by field (for reasons). */
  byField: Record<ContextField, string[]>;
  mentioned: boolean;
}

function idf(total: number, df: number): number {
  return Math.log(1 + (total - df + 0.5) / (df + 0.5));
}

function mentionMatches(pathLower: string, mentions: readonly string[]): boolean {
  return mentions.some((mention) => pathLower === mention || pathLower.endsWith(`/${mention}`));
}

/** The files scoring above zero, best first (score, then path). */
export function rankFiles(prepared: PreparedIndex, query: ParsedQuery, options: { mode?: RetrievalMode; limit?: number } = {}): RankedFile[] {
  const fields = MODE_FIELDS[options.mode ?? 'full'];
  const total = prepared.docs.length;
  if (total === 0 || (query.terms.length === 0 && query.mentions.length === 0)) return [];
  const df = new Map<string, number>();
  for (const { term } of query.terms) {
    let count = 0;
    for (const doc of prepared.docs) {
      if (fields.some((field) => doc.fields[field].has(term))) count += 1;
    }
    df.set(term, count);
  }
  const ranked: RankedFile[] = [];
  for (const doc of prepared.docs) {
    let score = 0;
    const contributions: Array<{ term: WeightedTerm; value: number }> = [];
    const byField: Record<ContextField, string[]> = { name: [], dir: [], symbols: [], content: [] };
    for (const term of query.terms) {
      let saturated = 0;
      for (const field of fields) {
        const tf = doc.fields[field].get(term.term);
        if (!tf) continue;
        const norm = 1 - FIELD_B[field] + FIELD_B[field] * (doc.lengths[field] / prepared.averages[field]);
        saturated += FIELD_WEIGHT[field] * ((tf * (K1 + 1)) / (tf + K1 * norm));
        byField[field].push(term.surface);
      }
      if (saturated === 0) continue;
      const value = term.weight * idf(total, df.get(term.term) ?? 0) * saturated;
      score += value;
      contributions.push({ term, value });
    }
    const mentioned = query.mentions.length > 0 && mentionMatches(doc.pathLower, query.mentions);
    if (mentioned) score += PATH_MENTION_BONUS;
    score *= filePrior(doc, query);
    if (score <= 0) continue;
    contributions.sort((a, b) => b.value - a.value || comparePaths(a.term.term, b.term.term));
    ranked.push({ doc, score, matched: contributions.map((entry) => entry.term), byField, mentioned });
  }
  ranked.sort((a, b) => b.score - a.score || comparePaths(a.doc.file.path, b.doc.file.path));
  return options.limit === undefined ? ranked : ranked.slice(0, options.limit);
}

/** Human-readable reasons for one ranked file (shown in the UI and the prompt). */
export function reasonsFor(ranked: RankedFile): string[] {
  const reasons: string[] = [];
  const unique = (values: readonly string[]) => [...new Set(values)].slice(0, 4).join(', ');
  if (ranked.mentioned) reasons.push('named in the task');
  if (ranked.byField.name.length > 0) reasons.push(`file name: ${unique(ranked.byField.name)}`);
  if (ranked.byField.dir.length > 0) reasons.push(`folder: ${unique(ranked.byField.dir)}`);
  if (ranked.byField.symbols.length > 0) {
    const terms = new Set(ranked.matched.map((entry) => entry.term));
    const symbols = ranked.doc.symbols.filter((symbol) => tokenize(symbol).some((term) => terms.has(term))).slice(0, 3);
    reasons.push(symbols.length > 0 ? `declares ${symbols.join(', ')}` : `symbols: ${unique(ranked.byField.symbols)}`);
  }
  if (ranked.byField.content.length > 0) reasons.push(`mentions ${unique(ranked.byField.content)}`);
  return reasons;
}

export interface Excerpt {
  startLine: number;
  endLine: number;
  lines: string[];
}

const MAX_SCAN_LINE = 400;

/**
 * The window of at most `maxLines` lines with the most matched query terms
 * (a declaration of a matching symbol counts extra); the first meaningful
 * lines when nothing matches. Line numbers are 1-based.
 */
export function chooseExcerpt(text: string, language: string, terms: ReadonlySet<string>, maxLines: number): Excerpt | null {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0 || maxLines <= 0) return null;
  const declared = new Map(extractSymbols(language, lines).map((hit) => [hit.line - 1, hit.name]));
  const scores = lines.map((line, index) => {
    if (terms.size === 0 || isTrivialLine(line)) return 0;
    const lineTerms = new Set(tokenize(line.slice(0, MAX_SCAN_LINE)));
    let score = 0;
    for (const term of lineTerms) if (terms.has(term)) score += 1;
    const symbol = declared.get(index);
    if (score > 0 && symbol !== undefined) score += 2;
    return score;
  });
  const width = Math.min(maxLines, lines.length);
  let best = -1;
  let bestStart = 0;
  let window = 0;
  for (let index = 0; index < lines.length; index += 1) {
    window += scores[index] ?? 0;
    if (index >= width) window -= scores[index - width] ?? 0;
    const start = index - width + 1;
    if (start >= 0 && window > best) {
      best = window;
      bestStart = start;
    }
  }
  let start = bestStart;
  if (best > 0) {
    // Start two lines above the first matching line (never losing a match:
    // the lines skipped at the top scored nothing).
    let first = bestStart;
    while (first < bestStart + width && (scores[first] ?? 0) === 0) first += 1;
    start = Math.min(Math.max(bestStart, first - 2), lines.length - width);
  } else {
    start = lines.findIndex((line) => !isTrivialLine(line));
    if (start === -1) start = 0;
  }
  let end = Math.min(lines.length, start + width) - 1;
  while (end > start && (lines[end] ?? '').trim() === '') end -= 1;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  return { startLine: start + 1, endLine: end + 1, lines: lines.slice(start, end + 1) };
}
