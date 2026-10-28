import { describe, expect, it } from 'vitest';
import {
  alignSections,
  assembleTrackedFiles,
  buildUntrackedFile,
  createLineBudget,
  cutText,
  expectedSectionHeader,
  gitQuotedName,
  parseListing,
  parseSectionHunks,
  resolveDiffLimits,
  splitPatchSections,
  type ListingEntry,
} from './diff-parser';
import { buildDiffArgs, buildUntrackedArgs, validateBaseParam } from './git-diff';
import type { TaskDiffLimits } from './types';

const SHA = 'a'.repeat(40);

function listing(...fields: string[]): string {
  return `${fields.join('\0')}\0`;
}

function patch(...lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function limits(overrides: Partial<TaskDiffLimits> = {}) {
  return resolveDiffLimits(overrides);
}

function entry(overrides: Partial<ListingEntry> & { path: string }): ListingEntry {
  return { rawStatus: 'M', oldMode: '100644', newMode: '100644', binary: false, additions: 0, deletions: 0, ...overrides };
}

describe('parseSectionHunks', () => {
  it('numbers lines across several hunks of a modified file', () => {
    const lines = [
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,4 +1,5 @@ export function a() {',
      ' one',
      '-two',
      '+TWO',
      '+two and a half',
      ' three',
      ' four',
      '@@ -10,3 +11,3 @@ function foo()',
      ' ten',
      '-eleven',
      '+ELEVEN',
      ' twelve',
    ];
    const { hunks, truncated } = parseSectionHunks(lines, limits(), createLineBudget(limits()));
    expect(truncated).toBe(false);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ header: '@@ -1,4 +1,5 @@ export function a() {', oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 });
    expect(hunks[0].lines).toEqual([
      { kind: 'context', oldNo: 1, newNo: 1, text: 'one' },
      { kind: 'del', oldNo: 2, text: 'two' },
      { kind: 'add', newNo: 2, text: 'TWO' },
      { kind: 'add', newNo: 3, text: 'two and a half' },
      { kind: 'context', oldNo: 3, newNo: 4, text: 'three' },
      { kind: 'context', oldNo: 4, newNo: 5, text: 'four' },
    ]);
    expect(hunks[1].lines).toEqual([
      { kind: 'context', oldNo: 10, newNo: 11, text: 'ten' },
      { kind: 'del', oldNo: 11, text: 'eleven' },
      { kind: 'add', newNo: 12, text: 'ELEVEN' },
      { kind: 'context', oldNo: 12, newNo: 13, text: 'twelve' },
    ]);
  });

  it('parses added and deleted files (omitted counts default to 1)', () => {
    const added = parseSectionHunks(['new file mode 100644', '--- /dev/null', '+++ b/n.txt', '@@ -0,0 +1,2 @@', '+x', '+y'], limits(), createLineBudget(limits()));
    expect(added.hunks[0].lines).toEqual([{ kind: 'add', newNo: 1, text: 'x' }, { kind: 'add', newNo: 2, text: 'y' }]);
    const deleted = parseSectionHunks(['deleted file mode 100644', '@@ -1 +0,0 @@', '-gone'], limits(), createLineBudget(limits()));
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
    expect(deleted.hunks[0].lines).toEqual([{ kind: 'del', oldNo: 1, text: 'gone' }]);
  });

  it('attaches "\\ No newline at end of file" to the line before it', () => {
    const { hunks } = parseSectionHunks(
      ['@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', '\\ No newline at end of file', '\\ stray marker'],
      limits(),
      createLineBudget(limits()),
    );
    expect(hunks[0].lines).toEqual([
      { kind: 'del', oldNo: 1, text: 'a', noEol: true },
      { kind: 'add', newNo: 1, text: 'b', noEol: true },
    ]);
  });

  it('drops exactly one trailing CR (CRLF files) and keeps every other byte', () => {
    const { hunks } = parseSectionHunks(['@@ -1,2 +1,2 @@\r', '-old\r', '+a\rb\r', ' \tctx\r\r'], limits(), createLineBudget(limits()));
    expect(hunks[0].header).toBe('@@ -1,2 +1,2 @@');
    expect(hunks[0].lines.map((line) => line.text)).toEqual(['old', 'a\rb', '\tctx\r']);
  });

  it('cuts long lines at maxLineChars without splitting a surrogate pair', () => {
    const l = limits({ maxLineChars: 5 });
    const { hunks } = parseSectionHunks(['@@ -0,0 +1,3 @@', '+0123456789', '+abcd😀xyz', '+short'], l, createLineBudget(l));
    expect(hunks[0].lines).toEqual([
      { kind: 'add', newNo: 1, text: '01234', truncated: true },
      { kind: 'add', newNo: 2, text: 'abcd', truncated: true },
      { kind: 'add', newNo: 3, text: 'short' },
    ]);
    expect(cutText('abc', 3)).toEqual({ text: 'abc', cut: false });
  });

  it('stops at maxLinesPerFile and marks the file truncated', () => {
    const l = limits({ maxLinesPerFile: 3 });
    const body = Array.from({ length: 10 }, (_, i) => `+line ${i}`);
    const first = parseSectionHunks(['@@ -0,0 +1,10 @@', ...body], l, createLineBudget(l));
    expect(first.truncated).toBe(true);
    expect(first.hunks[0].lines).toHaveLength(3);
    // A second hunk after the cap is not started.
    const two = parseSectionHunks(['@@ -1,3 +1,3 @@', ' a', '-b', '+B', '@@ -9 +9 @@', '-x', '+y'], l, createLineBudget(l));
    expect(two.hunks).toHaveLength(1);
    expect(two.truncated).toBe(true);
    // Exactly at the cap is not truncated.
    expect(parseSectionHunks(['@@ -1,2 +1,1 @@', '-a', ' b'], limits({ maxLinesPerFile: 2 }), createLineBudget(l)).truncated).toBe(false);
  });

  it('ignores garbage, malformed hunk headers and lines past a hunk', () => {
    const { hunks, truncated } = parseSectionHunks(
      [
        'similarity index 90%',
        '+not in a hunk yet',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '+past the counts',
        ' also past',
        '',
        '*** junk',
        '@@ -x,1 +y @@ malformed',
        '+ignored after malformed header',
        `@@ -1,1 +${'9'.repeat(30)} @@ unsafe number`,
        '+ignored',
      ],
      limits(),
      createLineBudget(limits()),
    );
    expect(truncated).toBe(false);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([{ kind: 'del', oldNo: 1, text: 'a' }, { kind: 'add', newNo: 1, text: 'b' }]);
  });

  it('reports a hunk that ends early (cut patch) as truncated', () => {
    expect(parseSectionHunks(['@@ -1,3 +1,3 @@', ' a'], limits(), createLineBudget(limits())).truncated).toBe(true);
    expect(parseSectionHunks(['@@ -1,3 +1,3 @@', ' a', '@@ -9 +9 @@', '-x', '+y'], limits(), createLineBudget(limits())).truncated).toBe(true);
  });
});

describe('parseListing', () => {
  it('pairs raw and numstat records, maps statuses and keeps rename/copy paths', () => {
    const parsed = parseListing(listing(
      ':100644 100644 1111111 0000000 M', 'src/a.ts',
      ':000000 100644 0000000 0000000 A', 'new file.txt',
      ':100644 000000 1111111 0000000 D', 'gone.txt',
      ':100644 100644 1111111 0000000 R087', 'old\tname.txt', 'new\nname.txt',
      ':100644 100644 1111111 0000000 C075', 'src/a.ts', 'src/copy.ts',
      ':100644 120000 1111111 0000000 T', 'link',
      ':100644 100644 1111111 0000000 M', 'image.png',
      '3\t2\tsrc/a.ts',
      '2\t0\tnew file.txt',
      '0\t4\tgone.txt',
      '1\t1\t', 'old\tname.txt', 'new\nname.txt',
      '0\t0\t', 'src/a.ts', 'src/copy.ts',
      '1\t1\tlink',
      '-\t-\timage.png',
    ));
    expect(parsed.incomplete).toBe(false);
    expect(parsed.entries.map((e) => [e.rawStatus, e.path, e.oldPath, e.additions, e.deletions, e.binary, e.score])).toEqual([
      ['M', 'src/a.ts', undefined, 3, 2, false, undefined],
      ['A', 'new file.txt', undefined, 2, 0, false, undefined],
      ['D', 'gone.txt', undefined, 0, 4, false, undefined],
      ['R', 'new\nname.txt', 'old\tname.txt', 1, 1, false, 87],
      ['C', 'src/copy.ts', 'src/a.ts', 0, 0, false, 75],
      ['T', 'link', undefined, 1, 1, false, undefined],
      ['M', 'image.png', undefined, 0, 0, true, undefined],
    ]);
  });

  it('drops stat-only entries (raw record without numstat) and paths that look like records are not misread', () => {
    const parsed = parseListing(listing(
      ':100644 100644 1111111 0000000 M', 'touched.txt',
      ':100644 100644 1111111 0000000 M', ':100644 100644 1111111 0000000 M',
      ':000000 100644 0000000 0000000 A', '1\t2\tlooks-like-numstat',
      '1\t1\t:100644 100644 1111111 0000000 M',
      '5\t0\t1\t2\tlooks-like-numstat',
    ));
    expect(parsed.entries.map((e) => e.path)).toEqual([':100644 100644 1111111 0000000 M', '1\t2\tlooks-like-numstat']);
    expect(parsed.entries[1].additions).toBe(5);
  });

  it('keeps entries with unknown counts when the listing was cut, and stops at unknown records', () => {
    const cut = parseListing(`${listing(':100644 100644 1111111 0000000 M', 'a.txt', ':100644 100644 1111111 0000000 M', 'b.txt', '1\t1\ta.txt')}2\t`, true);
    expect(cut.incomplete).toBe(true);
    expect(cut.entries).toEqual([
      expect.objectContaining({ path: 'a.txt', additions: 1 }),
      expect.objectContaining({ path: 'b.txt', countsUnknown: true }),
    ]);
    const midRecord = parseListing(':100644 100644 1111111 0000000 R100\0old\0');
    expect(midRecord).toEqual({ entries: [], incomplete: true });
    const junk = parseListing(listing('garbage', 'x'));
    expect(junk).toEqual({ entries: [], incomplete: true });
    expect(parseListing('')).toEqual({ entries: [], incomplete: false });
  });
});

describe('patch section alignment', () => {
  it('quotes names like git (core.quotePath=true)', () => {
    expect(gitQuotedName('a/', 'plain name.txt')).toBe('a/plain name.txt');
    expect(gitQuotedName('a/', 'tab\there')).toBe('"a/tab\\there"');
    expect(gitQuotedName('b/', 'q"b\\s\x7f\x01')).toBe('"b/q\\"b\\\\s\\177\\001"');
    expect(gitQuotedName('a/', 'café')).toBe('"a/caf\\303\\251"');
    expect(expectedSectionHeader(entry({ path: 'new', oldPath: 'old', rawStatus: 'R' }))).toBe('diff --git a/old b/new');
    expect(expectedSectionHeader(entry({ path: 'bad�name' }))).toBeNull();
  });

  it('assigns two sections to a typechange and none to an identical binary', () => {
    const sections = splitPatchSections(patch(
      'diff --git a/link b/link', 'deleted file mode 100644', '@@ -1 +0,0 @@', '-file',
      'diff --git a/link b/link', 'new file mode 120000', '@@ -0,0 +1 @@', '+target', '\\ No newline at end of file',
      'diff --git a/after.txt b/after.txt', '@@ -1 +1 @@', '-a', '+b',
    ));
    const entries = [
      entry({ path: 'link', rawStatus: 'T', additions: 1, deletions: 1 }),
      entry({ path: 'same.bin', binary: true }),
      entry({ path: 'after.txt', additions: 1, deletions: 1 }),
    ];
    const aligned = alignSections(entries, sections);
    expect(aligned.map((owned) => owned.length)).toEqual([2, 0, 1]);
    const { files, truncated } = assembleTrackedFiles(entries, patch(
      'diff --git a/link b/link', 'deleted file mode 100644', '@@ -1 +0,0 @@', '-file',
      'diff --git a/link b/link', 'new file mode 120000', '@@ -0,0 +1 @@', '+target', '\\ No newline at end of file',
      'diff --git a/after.txt b/after.txt', '@@ -1 +1 @@', '-a', '+b',
    ), false, limits(), createLineBudget(limits()));
    expect(truncated).toBe(false);
    expect(files[0]).toMatchObject({ path: 'link', status: 'modified' });
    expect(files[0].hunks.map((h) => h.lines)).toEqual([[{ kind: 'del', oldNo: 1, text: 'file' }], [{ kind: 'add', newNo: 1, text: 'target', noEol: true }]]);
    expect(files[1]).toMatchObject({ path: 'same.bin', status: 'binary', hunks: [] });
    expect(files[2].hunks[0].lines).toHaveLength(2);
  });

  it('resyncs past an unexpected section, and trusts order for undecodable paths', () => {
    const sections = splitPatchSections(patch(
      'diff --git a/unexpected b/unexpected', '@@ -1 +1 @@', '-u', '+U',
      'diff --git a/a.txt b/a.txt', '@@ -1 +1 @@', '-a', '+A',
      'diff --git "a/\\377" "b/\\377"', '@@ -1 +1 @@', '-x', '+X',
      'diff --git a/bin b/bin', 'Binary files a/bin and b/bin differ',
    ));
    const aligned = alignSections([
      entry({ path: 'a.txt' }),
      entry({ path: '�' }),
      entry({ path: 'bin�', binary: true }),
      entry({ path: 'missing.txt' }),
    ], sections);
    expect(aligned.map((owned) => owned.map((s) => s.header))).toEqual([
      ['diff --git a/a.txt b/a.txt'],
      ['diff --git "a/\\377" "b/\\377"'],
      ['diff --git a/bin b/bin'],
      [],
    ]);
  });

  it('marks files whose section is missing or cut by maxPatchBytes', () => {
    const entries = [entry({ path: 'a.txt', additions: 3 }), entry({ path: 'b.txt', additions: 1 }), entry({ path: 'c.bin', binary: true })];
    const { files, truncated } = assembleTrackedFiles(entries, 'diff --git a/a.txt b/a.txt\n@@ -0,0 +1,3 @@\n+one\n+tw', true, limits(), createLineBudget(limits()));
    expect(truncated).toBe(true);
    expect(files[0]).toMatchObject({ truncated: true, additions: 3 });
    expect(files[0].hunks[0].lines.map((l) => l.text)).toEqual(['one', 'tw']);
    expect(files[1]).toMatchObject({ truncated: true, hunks: [] });
    expect(files[2].truncated).toBeUndefined();
  });

  it('shares the global line budget across files; later files get no hunks', () => {
    const l = limits({ maxTotalLines: 5 });
    const text = patch(
      'diff --git a/one b/one', '@@ -0,0 +1,4 @@', '+1', '+2', '+3', '+4',
      'diff --git a/two b/two', '@@ -0,0 +1,4 @@', '+1', '+2', '+3', '+4',
      'diff --git a/three b/three', '@@ -0,0 +1,1 @@', '+1',
      'diff --git a/mode b/mode', 'old mode 100644', 'new mode 100755',
    );
    const entries = ['one', 'two', 'three'].map((path) => entry({ path, rawStatus: 'A' }));
    entries.push(entry({ path: 'mode', newMode: '100755' }));
    const budget = createLineBudget(l);
    const { files } = assembleTrackedFiles(entries, text, false, l, budget);
    expect(files.map((f) => f.hunks.reduce((n, h) => n + h.lines.length, 0))).toEqual([4, 1, 0, 0]);
    expect(files.map((f) => f.truncated ?? false)).toEqual([false, true, true, false]);
    expect(budget.remaining).toBe(0);
  });

  it('shows at most maxFiles entries and keeps similarity for renames', () => {
    const entries = Array.from({ length: 4 }, (_, i) => entry({ path: `f${i}`, oldPath: `o${i}`, rawStatus: 'R', score: 90 }));
    const { files } = assembleTrackedFiles(entries, '', false, limits({ maxFiles: 2 }), createLineBudget(limits()));
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: 'f0', oldPath: 'o0', status: 'renamed', similarity: 90 });
  });
});

describe('buildUntrackedFile', () => {
  it('synthesizes one all-add hunk, honouring noEol, CRLF and limits', () => {
    const l = limits();
    expect(buildUntrackedFile('u.txt', { kind: 'text', text: 'a\r\nb\n', cut: false }, l, createLineBudget(l))).toEqual({
      path: 'u.txt', status: 'added', additions: 2, deletions: 0, untracked: true,
      hunks: [{ header: '@@ -0,0 +1,2 @@', oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: [{ kind: 'add', newNo: 1, text: 'a' }, { kind: 'add', newNo: 2, text: 'b' }] }],
    });
    const single = buildUntrackedFile('one', { kind: 'text', text: 'last', cut: false }, l, createLineBudget(l));
    expect(single.hunks[0]).toMatchObject({ header: '@@ -0,0 +1 @@', lines: [{ kind: 'add', newNo: 1, text: 'last', noEol: true }] });
    expect(buildUntrackedFile('empty', { kind: 'text', text: '', cut: false }, l, createLineBudget(l))).toMatchObject({ additions: 0, hunks: [] });
    expect(buildUntrackedFile('bin', { kind: 'binary' }, l, createLineBudget(l))).toEqual({ path: 'bin', status: 'binary', additions: 0, deletions: 0, hunks: [], untracked: true });
    const link = buildUntrackedFile('link', { kind: 'symlink', target: '/etc/passwd' }, l, createLineBudget(l));
    expect(link).toMatchObject({ status: 'added', additions: 1, hunks: [{ lines: [{ kind: 'add', newNo: 1, text: '/etc/passwd', noEol: true }] }] });
  });

  it('marks cut content, per-file caps and an exhausted budget as truncated', () => {
    const l = limits({ maxLinesPerFile: 2, maxLineChars: 3 });
    const cut = buildUntrackedFile('big', { kind: 'text', text: 'abcdef\nb\npar', cut: true }, l, createLineBudget(l));
    expect(cut).toMatchObject({ additions: 3, truncated: true });
    expect(cut.hunks[0].lines).toEqual([{ kind: 'add', newNo: 1, text: 'abc', truncated: true }, { kind: 'add', newNo: 2, text: 'b' }]);
    const budget = { remaining: 0 };
    expect(buildUntrackedFile('late', { kind: 'text', text: 'x\n', cut: false }, l, budget)).toMatchObject({ additions: 1, hunks: [], truncated: true });
  });
});

describe('limits, arguments and base validation', () => {
  it('applies overrides and rejects invalid limits', () => {
    expect(resolveDiffLimits()).toEqual({
      maxFiles: 300, maxLinesPerFile: 5000, maxTotalLines: 20000, maxLineChars: 1000, maxPatchBytes: 8 * 1024 * 1024, maxUntrackedFileBytes: 512 * 1024,
    });
    expect(resolveDiffLimits({ maxFiles: 5 }).maxFiles).toBe(5);
    expect(() => resolveDiffLimits({ maxFiles: 0 })).toThrow(RangeError);
    expect(() => resolveDiffLimits({ maxLineChars: 1.5 })).toThrow(RangeError);
  });

  it('builds hardened diff arguments', () => {
    for (const mode of ['listing', 'patch', 'quiet'] as const) {
      const args = buildDiffArgs('/wt', SHA, mode);
      expect(args.slice(0, 3)).toEqual(['-C', '/wt', '--no-optional-locks']);
      for (const flag of ['--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=all', '-M', '--src-prefix=a/', '--dst-prefix=b/']) {
        expect(args).toContain(flag);
      }
      for (const config of [
        'protocol.allow=never', 'protocol.file.allow=never', 'protocol.https.allow=never', 'protocol.http.allow=never',
        'protocol.ssh.allow=never', 'protocol.git.allow=never', 'protocol.ext.allow=never', 'diff.autoRefreshIndex=false', 'core.quotePath=true',
      ]) {
        expect(args[args.indexOf(config) - 1]).toBe('-c');
      }
      // Global options precede the subcommand; the pathspec closes the argv.
      expect(args.indexOf('diff')).toBeGreaterThan(args.lastIndexOf('-c'));
      expect(args.slice(-4)).toEqual([SHA, '--', '.', ':(exclude).sisyphus']);
    }
    expect(buildDiffArgs('/wt', SHA, 'listing')).toEqual(expect.arrayContaining(['--raw', '--numstat', '-z']));
    expect(buildDiffArgs('/wt', SHA, 'patch')).toEqual(expect.arrayContaining(['-p', '--unified=3']));
    expect(() => buildDiffArgs('/wt', '--output=/tmp/x', 'patch')).toThrow();
    const untracked = buildUntrackedArgs('/wt');
    expect(untracked[0]).toBe('-C');
    expect(untracked.slice(-7)).toEqual(['ls-files', '--others', '--exclude-standard', '-z', '--', '.', ':(exclude).sisyphus']);
  });

  it('validates the base parameter', () => {
    expect(validateBaseParam(undefined)).toBeUndefined();
    expect(validateBaseParam('')).toBeUndefined();
    expect(validateBaseParam('origin/main')).toBe('origin/main');
    expect(validateBaseParam('A'.repeat(40))).toBe('a'.repeat(40));
    expect(validateBaseParam('b'.repeat(64))).toBe('b'.repeat(64));
    for (const bad of ['--output=x', '-x', 'a..b', 'HEAD~1', 'main@{1}', 'with space', ['a', 'b'], { a: 1 }, 'x'.repeat(256)]) {
      expect(() => validateBaseParam(bad)).toThrow(expect.objectContaining({ statusCode: 400, code: 'INVALID_BASE_REF' }));
    }
  });
});
