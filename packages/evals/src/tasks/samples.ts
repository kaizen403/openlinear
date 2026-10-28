import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git } from '../util/git';
import { taskChecksum } from './holdout';
import { HOLDOUT_SCHEMA_VERSION, type HoldoutIndex, TASK_SCHEMA_VERSION, type TaskSpec } from './types';

/**
 * Five tiny synthetic tasks for the offline smoke suite. Each is a one-file
 * Node ESM library with a bug and a visible failing `node:test` test; the
 * grader holds the authoritative copy of that test plus hidden cases. They
 * are written to a temp dir in the private-holdout format at run time.
 *
 * They exercise the pipeline only — they say nothing about model quality.
 */

export interface SampleTaskSource {
  id: string;
  title: string;
  category: string;
  cluster: string;
  split: TaskSpec['split'];
  instruction: string;
  /** Seed repository (buggy). */
  files: Record<string, string>;
  /** Correct fix: changed files with their full new content. */
  fixed: Record<string, string>;
  /** A plausible but wrong fix (passes some visible checks, fails the grader). */
  wrongFix: Record<string, string>;
  /** Grader assets copied over the pristine checkout before the verifier runs. */
  grader: Record<string, string>;
  verifierCommand: string[];
}

export function graderCanary(taskId: string): string {
  return `OPENLINEAR-EVAL-GRADER-CANARY-${taskId}`;
}

const PKG = `${JSON.stringify({ name: 'eval-sample', private: true, type: 'module' }, null, 2)}\n`;

const sumRange = {
  buggy: `/** Sum of all integers between a and b, inclusive, in either order. */
export function sumRange(a, b) {
  let total = 0;
  for (let i = a; i < b; i += 1) total += i;
  return total;
}
`,
  fixed: `/** Sum of all integers between a and b, inclusive, in either order. */
export function sumRange(a, b) {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  let total = 0;
  for (let i = lo; i <= hi; i += 1) total += i;
  return total;
}
`,
  wrong: `/** Sum of all integers between a and b, inclusive, in either order. */
export function sumRange(a, b) {
  let total = 0;
  for (let i = a; i <= b; i += 1) total += i;
  return total;
}
`,
  visibleTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumRange } from '../src/range.mjs';

test('sums an inclusive ascending range', () => {
  assert.equal(sumRange(1, 3), 6);
});
`,
  hiddenTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sumRange } from '../src/range.mjs';

test('sums an inclusive ascending range', () => {
  assert.equal(sumRange(1, 3), 6);
});

test('single element and negatives', () => {
  assert.equal(sumRange(5, 5), 5);
  assert.equal(sumRange(-2, 2), 0);
});

test('descending order is inclusive too', () => {
  assert.equal(sumRange(3, 1), 6);
});
`,
};

const slugify = {
  buggy: `/** URL slug: lowercase ASCII words joined by single dashes, no leading/trailing dash. */
export function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '-');
}
`,
  fixed: `/** URL slug: lowercase ASCII words joined by single dashes, no leading/trailing dash. */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
`,
  wrong: `/** URL slug: lowercase ASCII words joined by single dashes, no leading/trailing dash. */
export function slugify(title) {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
`,
  visibleTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.mjs';

test('joins words with single dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Hello,  World!  '), 'hello-world');
});
`,
  hiddenTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify } from '../src/slugify.mjs';

test('joins words with single dashes', () => {
  assert.equal(slugify('Hello World'), 'hello-world');
  assert.equal(slugify('  Hello,  World!  '), 'hello-world');
});

test('idempotent on slugs and empty for symbols', () => {
  assert.equal(slugify('Already-Slugged'), 'already-slugged');
  assert.equal(slugify('***'), '');
});
`,
};

const duration = {
  buggy: `const UNITS = { h: 3_600_000, m: 60_000, s: 1000 };

/** Parse durations such as "1h30m", "45s" or "2h" into milliseconds. Throws on invalid input. */
export function parseDuration(text) {
  const match = /^(\\d+)([hms])/.exec(text);
  if (!match) throw new Error(\`invalid duration: \${text}\`);
  return Number(match[1]) * UNITS[match[2]];
}
`,
  fixed: `const UNITS = { h: 3_600_000, m: 60_000, s: 1000 };

/** Parse durations such as "1h30m", "45s" or "2h" into milliseconds. Throws on invalid input. */
export function parseDuration(text) {
  if (!/^(\\d+[hms])+$/.test(text)) throw new Error(\`invalid duration: \${text}\`);
  let total = 0;
  for (const match of text.matchAll(/(\\d+)([hms])/g)) total += Number(match[1]) * UNITS[match[2]];
  return total;
}
`,
  wrong: `const UNITS = { h: 3_600_000, m: 60_000, s: 1000 };

/** Parse durations such as "1h30m", "45s" or "2h" into milliseconds. Throws on invalid input. */
export function parseDuration(text) {
  let total = 0;
  for (const match of text.matchAll(/(\\d+)([hms])/g)) total += Number(match[1]) * UNITS[match[2]];
  return total;
}
`,
  visibleTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.mjs';

test('parses compound durations', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
});
`,
  hiddenTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration } from '../src/duration.mjs';

test('parses compound durations', () => {
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1h1m1s'), 3_661_000);
});

test('parses single units', () => {
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('90s'), 90_000);
});

test('rejects invalid input', () => {
  assert.throws(() => parseDuration('5x'));
  assert.throws(() => parseDuration(''));
});
`,
};

const lru = {
  buggy: `/** Least-recently-used cache: reading or writing a key makes it the most recent. */
export class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
}
`,
  fixed: `/** Least-recently-used cache: reading or writing a key makes it the most recent. */
export class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
}
`,
  wrong: `/** Least-recently-used cache: reading or writing a key makes it the most recent. */
export class LruCache {
  constructor(capacity) {
    this.capacity = capacity;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  get(key) {
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);
  }
}
`,
  visibleTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/lru.mjs';

test('reading a key protects it from eviction', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
});
`,
  hiddenTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/lru.mjs';

test('reading a key protects it from eviction', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('b'), undefined);
});

test('a miss does not insert', () => {
  const cache = new LruCache(2);
  cache.set('a', 1);
  assert.equal(cache.get('missing'), undefined);
  assert.equal(cache.size, 1);
});
`,
};

const semver = {
  buggy: `/** Compare "MAJOR.MINOR.PATCH" versions numerically: returns -1, 0 or 1. */
export function compareVersions(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
`,
  fixed: `/** Compare "MAJOR.MINOR.PATCH" versions numerically: returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}
`,
  wrong: `/** Compare "MAJOR.MINOR.PATCH" versions numerically: returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  if (am !== bm) return am < bm ? -1 : 1;
  if (an !== bn) return an < bn ? -1 : 1;
  return 0;
}
`,
  visibleTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/semver.mjs';

test('compares minor versions numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
});
`,
  hiddenTest: `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions } from '../src/semver.mjs';

test('compares minor versions numerically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});

test('equal and patch-level ordering', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
});
`,
};

function task(
  id: string,
  title: string,
  category: string,
  cluster: string,
  split: TaskSpec['split'],
  file: string,
  testFile: string,
  source: { buggy: string; fixed: string; wrong: string; visibleTest: string; hiddenTest: string },
  instruction: string,
): SampleTaskSource {
  return {
    id,
    title,
    category,
    cluster,
    split,
    instruction,
    files: { 'package.json': PKG, [file]: source.buggy, [testFile]: source.visibleTest },
    fixed: { [file]: source.fixed },
    wrongFix: { [file]: source.wrong },
    grader: { [testFile]: source.hiddenTest, 'CANARY.txt': `${graderCanary(id)}\n` },
    verifierCommand: ['node', '--test', testFile],
  };
}

export const SAMPLE_TASKS: readonly SampleTaskSource[] = [
  task(
    'sum-range-inclusive',
    'sumRange must be inclusive in either order',
    'logic',
    'mathkit',
    'development',
    'src/range.mjs',
    'test/range.test.mjs',
    sumRange,
    'The test `test/range.test.mjs` fails. Fix `sumRange` in `src/range.mjs`: it must return the sum of all integers between `a` and `b`, inclusive, whichever argument is larger. Check with `node --test test/range.test.mjs`.\n',
  ),
  task(
    'slugify-collapse',
    'slugify must collapse separators and trim dashes',
    'strings',
    'textkit',
    'development',
    'src/slugify.mjs',
    'test/slugify.test.mjs',
    slugify,
    'The test `test/slugify.test.mjs` fails. Fix `slugify` in `src/slugify.mjs` so it returns lowercase ASCII words joined by single dashes, with no leading or trailing dash. Check with `node --test test/slugify.test.mjs`.\n',
  ),
  task(
    'parse-duration-compound',
    'parseDuration must sum every component',
    'parsing',
    'timekit',
    'validation',
    'src/duration.mjs',
    'test/duration.test.mjs',
    duration,
    'The test `test/duration.test.mjs` fails. Fix `parseDuration` in `src/duration.mjs`: it must accept compound durations such as `1h30m` and `1h1m1s`, and throw on invalid input. Check with `node --test test/duration.test.mjs`.\n',
  ),
  task(
    'lru-refresh-on-get',
    'LruCache.get must refresh recency',
    'data-structures',
    'cachekit',
    'validation',
    'src/lru.mjs',
    'test/lru.test.mjs',
    lru,
    'The test `test/lru.test.mjs` fails. Fix `LruCache` in `src/lru.mjs` so that reading a key makes it the most recently used. Check with `node --test test/lru.test.mjs`.\n',
  ),
  task(
    'semver-numeric-compare',
    'compareVersions must compare numerically',
    'parsing',
    'versionkit',
    'sealed',
    'src/semver.mjs',
    'test/semver.test.mjs',
    semver,
    'The test `test/semver.test.mjs` fails. Fix `compareVersions` in `src/semver.mjs` so MAJOR.MINOR.PATCH versions compare numerically. Check with `node --test test/semver.test.mjs`.\n',
  ),
];

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

/** Unified diff (as `git diff` prints it) turning `files` into `files + changes`. */
export async function diffFor(files: Record<string, string>, changes: Record<string, string>): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'ol-eval-diff-'));
  try {
    await writeFiles(scratch, files);
    await git(scratch, ['init', '--quiet']);
    await git(scratch, ['add', '-A']);
    await git(scratch, ['commit', '--quiet', '--no-verify', '-m', 'base']);
    await writeFiles(scratch, changes);
    await git(scratch, ['add', '-A']);
    return await git(scratch, ['diff', '--cached', '--binary', 'HEAD']);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface SampleHoldout {
  root: string;
  sources: Map<string, SampleTaskSource>;
}

/** Writes the five sample tasks as a frozen private-holdout directory under `root`. */
export async function writeSampleHoldout(root: string): Promise<SampleHoldout> {
  const entries: HoldoutIndex['tasks'] = [];
  for (const source of SAMPLE_TASKS) {
    const dir = join(root, 'tasks', source.id);
    await writeFiles(join(dir, 'repo'), source.files);
    await writeFiles(join(dir, 'grader'), source.grader);
    await writeFile(join(dir, 'instruction.md'), source.instruction);
    await writeFile(join(dir, 'reference.patch'), await diffFor(source.files, source.fixed));
    const spec: TaskSpec = {
      schemaVersion: TASK_SCHEMA_VERSION,
      id: source.id,
      title: source.title,
      category: source.category,
      cluster: source.cluster,
      split: source.split,
      createdAt: '2026-10-26',
      author: 'openlinear-eval (synthetic)',
      instructionFile: 'instruction.md',
      repo: { kind: 'inline', dir: 'repo' },
      verifier: {
        command: source.verifierCommand,
        timeoutMs: 30_000,
        graderDir: 'grader',
        copyInto: '.',
        failToPass: [source.verifierCommand[2] ?? ''],
        passToPass: [],
      },
      protectedPaths: ['.github/', '.git/'],
      referencePatch: 'reference.patch',
      tags: source.split === 'sealed' ? ['synthetic', 'sealed'] : ['synthetic'],
    };
    await writeFile(join(dir, 'task.json'), `${JSON.stringify(spec, null, 2)}\n`);
    entries.push({ id: source.id, checksum: await taskChecksum(dir) });
  }
  const index: HoldoutIndex = {
    schemaVersion: HOLDOUT_SCHEMA_VERSION,
    id: 'openlinear-sample-holdout',
    description: 'Five synthetic smoke tasks generated at run time. Pipeline check only; not a benchmark.',
    frozenAt: '2026-10-26',
    tasks: entries,
  };
  await writeFile(join(root, 'holdout.json'), `${JSON.stringify(index, null, 2)}\n`);
  return { root, sources: new Map(SAMPLE_TASKS.map((source) => [source.id, source])) };
}
