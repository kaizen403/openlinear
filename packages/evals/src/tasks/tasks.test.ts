import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyOutcome } from '../grading/outcome';
import { patchPaths, scanSafety } from '../grading/safety';
import { checkTaskGates, gradePatch } from '../grading/verifier';
import { git } from '../util/git';
import { auditRepoHistory, loadHoldout, loadTask, materializeBaseRepo, TaskIntegrityError } from './holdout';
import { diffFor, graderCanary, SAMPLE_TASKS, writeSampleHoldout } from './samples';
import type { LoadedTask } from './types';

let root: string;
let holdoutRoot: string;
let tasks: LoadedTask[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'evals-tasks-'));
  holdoutRoot = join(root, 'holdout');
  await writeSampleHoldout(holdoutRoot);
  tasks = (await loadHoldout(holdoutRoot)).tasks;
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const byId = (id: string) => {
  const task = tasks.find((t) => t.spec.id === id);
  if (!task) throw new Error(id);
  return task;
};

describe('private holdout format', () => {
  it('writes and loads five frozen sample tasks with stable checksums', async () => {
    expect(tasks.map((t) => t.spec.id)).toEqual(SAMPLE_TASKS.map((t) => t.id));
    expect(tasks.filter((t) => t.sealed).map((t) => t.spec.id)).toEqual(['semver-numeric-compare']);
    const again = await mkdtemp(join(tmpdir(), 'evals-tasks-again-'));
    try {
      await writeSampleHoldout(again);
      const second = (await loadHoldout(again)).tasks;
      expect(second.map((t) => t.checksum)).toEqual(tasks.map((t) => t.checksum));
    } finally {
      await rm(again, { recursive: true, force: true });
    }
  });

  it('keeps grader assets out of the agent-facing text and repo', () => {
    for (const task of tasks) {
      expect(task.instruction).not.toContain(graderCanary(task.spec.id));
      expect(task.graderDir.startsWith(task.dir)).toBe(true);
      expect(task.graderDir.includes('/repo/')).toBe(false);
    }
  });

  it('rejects a task edited after the holdout was frozen', async () => {
    const copy = await mkdtemp(join(tmpdir(), 'evals-tamper-'));
    try {
      await writeSampleHoldout(copy);
      await writeFile(join(copy, 'tasks', 'slugify-collapse', 'grader', 'test', 'slugify.test.mjs'), '// weakened\n');
      await expect(loadHoldout(copy)).rejects.toThrow(TaskIntegrityError);
    } finally {
      await rm(copy, { recursive: true, force: true });
    }
  });

  it('materializes a deterministic, sanitized base commit', async () => {
    const one = await materializeBaseRepo(byId('sum-range-inclusive'), join(root, 'w1'));
    const two = await materializeBaseRepo(byId('sum-range-inclusive'), join(root, 'w2'));
    expect(one.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(two.baseSha).toBe(one.baseSha);
    expect(await auditRepoHistory(one.path, one.baseSha)).toEqual([]);
  });

  it('audits stray refs and remotes, and sanitizes git sources down to the base commit', async () => {
    const upstream = join(root, 'upstream');
    await git(root, ['init', '--quiet', upstream]);
    await writeFile(join(upstream, 'a.txt'), 'base\n');
    await git(upstream, ['add', '-A']);
    await git(upstream, ['commit', '--quiet', '-m', 'base']);
    const base = (await git(upstream, ['rev-parse', 'HEAD'])).trim();
    await writeFile(join(upstream, 'a.txt'), 'the fix\n');
    await git(upstream, ['commit', '--quiet', '-am', 'fix (future commit)']);
    await git(upstream, ['tag', 'v-fixed']);
    expect(await auditRepoHistory(upstream, base)).toEqual(expect.arrayContaining(['refs/heads/main points past the base commit', 'refs/tags/v-fixed points past the base commit']));

    const taskDir = join(root, 'git-task');
    const spec = JSON.parse(await readFile(join(holdoutRoot, 'tasks', 'sum-range-inclusive', 'task.json'), 'utf8'));
    spec.id = 'git-task';
    spec.repo = { kind: 'git', url: upstream, baseSha: base };
    await writeSampleHoldout(join(root, 'scratch-holdout'));
    const { cp } = await import('node:fs/promises');
    await cp(join(root, 'scratch-holdout', 'tasks', 'sum-range-inclusive'), taskDir, { recursive: true });
    await writeFile(join(taskDir, 'task.json'), JSON.stringify(spec));
    const gitTask = await loadTask(taskDir);
    const materialized = await materializeBaseRepo(gitTask, join(root, 'w3'));
    expect(materialized.baseSha).toBe(base);
    expect(await auditRepoHistory(materialized.path, base)).toEqual([]);
    const objects = await git(materialized.path, ['rev-list', '--all']);
    expect(objects.trim().split('\n')).toEqual([base]);
  });
});

describe('verifier', () => {
  it('passes every reference patch and fails every empty patch (task gates)', async () => {
    for (const task of tasks) {
      const base = await materializeBaseRepo(task, join(root, 'gates', task.spec.id));
      const gate = await checkTaskGates(task, base, join(root, 'gates', task.spec.id, 'scratch'));
      expect(gate, task.spec.id).toMatchObject({ referencePasses: true, emptyPatchFails: true, ok: true });
      expect(gate.empty.reason).toBe('empty-patch');
    }
  });

  it('fails plausible wrong fixes through the hidden grader tests', async () => {
    for (const source of SAMPLE_TASKS) {
      const task = byId(source.id);
      const base = await materializeBaseRepo(task, join(root, 'wrong', task.spec.id));
      const patch = await diffFor(source.files, source.wrongFix);
      const grade = await gradePatch({ task, base, patch, workRoot: join(root, 'wrong', 'scratch') });
      expect(grade.status, source.id).toBe('fail');
      expect(grade.reason).toBe('tests-failed');
    }
  });

  it('overwrites tests the agent edited, and fails patches that do not apply', async () => {
    const source = SAMPLE_TASKS.find((t) => t.id === 'slugify-collapse');
    if (!source) throw new Error('missing');
    const task = byId(source.id);
    const base = await materializeBaseRepo(task, join(root, 'cheat'));
    const cheat = await diffFor(source.files, { 'test/slugify.test.mjs': "import { test } from 'node:test';\ntest('nothing', () => {});\n" });
    expect((await gradePatch({ task, base, patch: cheat, workRoot: join(root, 'cheat', 'scratch') })).status).toBe('fail');
    const broken = 'diff --git a/src/nope.mjs b/src/nope.mjs\n--- a/src/nope.mjs\n+++ b/src/nope.mjs\n@@ -1 +1 @@\n-x\n+y\n';
    const grade = await gradePatch({ task, base, patch: broken, workRoot: join(root, 'cheat', 'scratch') });
    expect(grade).toMatchObject({ status: 'fail', reason: 'patch-does-not-apply', patchApplied: false });
  });

  it('reports a verifier timeout as an error, not a failure', async () => {
    const task = byId('sum-range-inclusive');
    const base = await materializeBaseRepo(task, join(root, 'slow'));
    const slow: LoadedTask = { ...task, spec: { ...task.spec, verifier: { ...task.spec.verifier, command: [process.execPath, '-e', 'setTimeout(() => {}, 10000)'] } } };
    const grade = await gradePatch({ task: slow, base, patch: '', workRoot: join(root, 'slow', 'scratch'), timeoutMs: 200 });
    expect(grade).toMatchObject({ status: 'error', reason: 'verifier-timeout' });
  });
});

describe('outcome classification and safety', () => {
  const pass = { status: 'pass' as const, reason: 'pass', patchApplied: true, exitCode: 0, durationMs: 1, stdoutTail: '', stderrTail: '', verifierRevision: 'x' };
  const fail = { ...pass, status: 'fail' as const, reason: 'tests-failed', exitCode: 1 };
  const error = { ...pass, status: 'error' as const, reason: 'verifier-timeout', exitCode: null };

  it.each([
    ['completed', pass, [], true, 'pass'],
    ['completed', fail, [], true, 'fail'],
    ['agent-error', fail, [], true, 'fail'],
    ['timeout', fail, [], true, 'timeout'],
    ['timeout', pass, [], true, 'pass'],
    ['timeout', pass, [], false, 'timeout'],
    ['budget', fail, [], true, 'timeout'],
    ['refused', fail, [], true, 'refusal'],
    ['infra', null, [], true, 'infra'],
    ['cancelled', null, [], true, 'infra'],
    ['completed', error, [], true, 'infra'],
    ['completed', pass, [{ kind: 'canary-in-patch' as const, detail: 'x' }], true, 'safety'],
  ] as const)('%s + %s → %s', (termination, grade, safety, gradeOnTimeout, expected) => {
    const result = classifyOutcome({ termination, grade, safety: [...safety], gradeOnTimeout });
    expect(result.outcome).toBe(expected);
    expect(result.success).toBe(expected === 'pass');
  });

  it('finds protected paths and canaries in patches and trajectories', () => {
    const patch = 'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1 +1 @@\n-a\n+CANARY-123456\n';
    expect(patchPaths(patch)).toEqual(['.github/workflows/ci.yml']);
    const findings = scanSafety({
      patch,
      events: [{ atMs: 1, event: { t: 'tool.output', callId: 'c', chunk: 'saw CANARY-123456' } }],
      protectedPaths: ['.github/'],
      canaries: ['CANARY-123456'],
    });
    expect(findings.map((f) => f.kind)).toEqual(['protected-path-modified', 'canary-in-patch', 'canary-in-trajectory']);
    expect(scanSafety({ patch: '', events: [], protectedPaths: ['.github/'], canaries: ['CANARY-123456'] })).toEqual([]);
  });
});
