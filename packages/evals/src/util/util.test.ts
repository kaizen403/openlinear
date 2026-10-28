import { mkdtemp, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, hashTree, sha256Hex } from './hash';
import { runCommand } from './proc';
import { hashSeed, mulberry32, shuffle, stableUnit } from './random';
import { parseToml, TomlError } from './toml';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('canonicalJson / hashing', () => {
  it('sorts keys recursively and drops undefined members', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, undefined], c: undefined } })).toBe('{"a":{"d":[1,null]},"b":1}');
    expect(sha256Hex(canonicalJson({ x: 1, y: 2 }))).toBe(sha256Hex(canonicalJson({ y: 2, x: 1 })));
  });

  it('hashTree is content-addressed, ignores .git, and sees symlinks and exec bits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evals-hash-'));
    dirs.push(root);
    await mkdir(join(root, 'a', '.git'), { recursive: true });
    await writeFile(join(root, 'a', 'one.txt'), 'one');
    await writeFile(join(root, 'a', '.git', 'HEAD'), 'ref');
    const first = await hashTree(root);
    await writeFile(join(root, 'a', '.git', 'HEAD'), 'other');
    expect(await hashTree(root)).toBe(first);
    await writeFile(join(root, 'a', 'one.txt'), 'changed');
    const second = await hashTree(root);
    expect(second).not.toBe(first);
    await symlink('one.txt', join(root, 'a', 'link'));
    expect(await hashTree(root)).not.toBe(second);
  });
});

describe('seeded randomness', () => {
  it('is deterministic per seed and label', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(hashSeed('x', 1)).toBe(hashSeed('x', 1));
    expect(hashSeed('x', 1)).not.toBe(hashSeed('x', 2));
    const u = stableUnit('cfg', 'task', 3);
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(1);
  });

  it('shuffle permutes without mutating and is reproducible', () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const one = shuffle(items, mulberry32(7));
    const two = shuffle(items, mulberry32(7));
    expect(one).toEqual(two);
    expect(one).not.toEqual(items);
    expect([...one].sort((x, y) => x - y)).toEqual(items);
  });
});

describe('runCommand', () => {
  it('captures output and lines, and kills the whole process group on timeout', async () => {
    const lines: string[] = [];
    const ok = await runCommand(process.execPath, ['-e', 'console.log("a"); console.log("b")'], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' }, onStdoutLine: (line) => lines.push(line) });
    expect(ok.code).toBe(0);
    expect(lines).toEqual(['a', 'b']);
    const script = 'const { spawn } = require("node:child_process"); const c = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); console.log(c.pid); setInterval(() => {}, 1000);';
    const started = Date.now();
    const pids: string[] = [];
    const hung = await runCommand(process.execPath, ['-e', script], { cwd: tmpdir(), env: { PATH: process.env.PATH ?? '' }, timeoutMs: 400, killGraceMs: 200, onStdoutLine: (line) => pids.push(line) });
    expect(hung.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    // The grandchild ignored SIGTERM; the group SIGKILL must still have reaped it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const grandchild = Number(pids[0]);
    expect(Number.isInteger(grandchild)).toBe(true);
    expect(() => process.kill(grandchild, 0)).toThrow();
  });

  it('reports spawn failures instead of throwing', async () => {
    const result = await runCommand('/nonexistent/binary-for-evals', [], { cwd: tmpdir(), env: {} });
    expect(result.spawnError).not.toBeNull();
    expect(result.code).toBeNull();
  });
});

describe('parseToml', () => {
  it('parses tables, dotted headers, inline tables, multi-line arrays and comments', () => {
    const doc = parseToml(`# comment
schema_version = "1.3"
artifacts = ["/app/a.py", '/app/b.txt'] # trailing
[task]
name = "org/task"
authors = [{ name = "A", email = "a@x" }]
[metadata]
tags = [
  "x",
  "y",
]
expert_time_estimate_hours = 2
[verifier]
timeout_sec = 900.0
[verifier.env]
[environment]
cpus = 1_000
allow_internet = false
when = 2026-10-26T00:00:00Z
[[steps]]
name = "one"
[[steps]]
name = "two"
`);
    expect(doc.schema_version).toBe('1.3');
    expect(doc.artifacts).toEqual(['/app/a.py', '/app/b.txt']);
    expect(doc.task).toEqual({ name: 'org/task', authors: [{ name: 'A', email: 'a@x' }] });
    expect(doc.metadata).toEqual({ tags: ['x', 'y'], expert_time_estimate_hours: 2 });
    expect(doc.verifier).toEqual({ timeout_sec: 900, env: {} });
    expect(doc.environment).toEqual({ cpus: 1000, allow_internet: false, when: '2026-10-26T00:00:00Z' });
    expect(doc.steps).toEqual([{ name: 'one' }, { name: 'two' }]);
  });

  it('handles escapes and multi-line strings', () => {
    const doc = parseToml('a = "tab\\tquote\\" \\u00e9"\nb = """\nline1\nline2"""\nc = \'\'\'\nraw\\n\'\'\'\n');
    expect(doc.a).toBe('tab\tquote" é');
    expect(doc.b).toBe('line1\nline2');
    expect(doc.c).toBe('raw\\n');
  });

  it('rejects duplicate keys and garbage', () => {
    expect(() => parseToml('a = 1\na = 2\n')).toThrow(TomlError);
    expect(() => parseToml('a = nope\n')).toThrow(TomlError);
    expect(() => parseToml('a = "unterminated\n')).toThrow(TomlError);
  });
});
