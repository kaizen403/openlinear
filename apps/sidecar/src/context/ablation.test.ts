import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABLATION_FILES, ABLATION_QUERIES } from './fixtures/ablation-corpus';
import { buildRepoIndex, type PreparedIndex, prepareIndex } from './repo-index';
import { parseQuery, rankFiles, type RetrievalMode } from './retrieve';

/**
 * W16b ablation (offline, deterministic, no model): does indexing symbols
 * and content help over file paths alone? The corpus is a made-up repository
 * with tasks labelled by the files to change (fixtures/ablation-corpus.ts);
 * each mode ranks the files and we report precision@5, recall@5 and MRR.
 * The numbers are recorded in docs/reports/revamp-2026-10-26/context.md.
 */

const K = 5;

interface AblationMetrics {
  mode: RetrievalMode;
  precisionAt5: number;
  recallAt5: number;
  mrr: number;
  /** Queries with at least one expected file in the top 5. */
  hitAt5: number;
}

function evaluate(prepared: PreparedIndex, mode: RetrievalMode): AblationMetrics {
  let precision = 0;
  let recall = 0;
  let reciprocal = 0;
  let hits = 0;
  for (const query of ABLATION_QUERIES) {
    const top = rankFiles(prepared, parseQuery({ title: query.title, description: query.description }), { mode, limit: K }).map((entry) => entry.doc.file.path);
    const relevant = top.filter((path) => query.expected.includes(path)).length;
    precision += relevant / K;
    recall += relevant / query.expected.length;
    const first = top.findIndex((path) => query.expected.includes(path));
    reciprocal += first === -1 ? 0 : 1 / (first + 1);
    if (first !== -1) hits += 1;
  }
  const n = ABLATION_QUERIES.length;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { mode, precisionAt5: round(precision / n), recallAt5: round(recall / n), mrr: round(reciprocal / n), hitAt5: hits };
}

let root = '';
let prepared: PreparedIndex;

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ol-context-ablation-')));
  for (const [path, content] of Object.entries(ABLATION_FILES)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2026-10-27T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-27T10:00:00Z' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: root, env, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'corpus');
  prepared = prepareIndex(await buildRepoIndex({ dir: root, commit: git('rev-parse', 'HEAD') }));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('W16b retrieval ablation', () => {
  it('indexes the corpus (lockfile and .env skipped)', () => {
    expect(prepared.docs).toHaveLength(Object.keys(ABLATION_FILES).length - 2);
    expect(prepared.index.stats.skipped).toEqual({ lockfile: 1, secret: 1 });
  });

  it('symbols and content beat paths alone; the result is deterministic', () => {
    const results = (['path', 'path+symbols', 'full'] as const).map((mode) => evaluate(prepared, mode));
    const [path, symbols, full] = results;
    console.info(`W16b ablation (${ABLATION_QUERIES.length} tasks, ${prepared.docs.length} files)\n${results
      .map((r) => `${r.mode.padEnd(13)} P@5 ${r.precisionAt5.toFixed(3)}  R@5 ${r.recallAt5.toFixed(3)}  MRR ${r.mrr.toFixed(3)}  hit@5 ${r.hitAt5}/${ABLATION_QUERIES.length}`)
      .join('\n')}`);
    expect(full!.mrr).toBeGreaterThanOrEqual(path!.mrr);
    expect(full!.recallAt5).toBeGreaterThanOrEqual(path!.recallAt5);
    expect(full!.mrr).toBeGreaterThanOrEqual(symbols!.mrr);
    // Regression floor for the production mode.
    expect(full!.mrr).toBeGreaterThanOrEqual(0.8);
    expect(full!.recallAt5).toBeGreaterThanOrEqual(0.9);
    expect(evaluate(prepared, 'full')).toEqual(full);
  });
});
