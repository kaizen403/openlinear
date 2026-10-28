import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { hashTree } from '../util/hash';
import { git, gitTry } from '../util/git';
import { HoldoutIndexSchema, type HoldoutIndex, type LoadedTask, TaskSpecSchema } from './types';

export class TaskIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskIntegrityError';
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

/** Checksum of the complete task definition (instruction, verifier, grader assets, seed repo, reference). */
export function taskChecksum(taskDir: string): Promise<string> {
  return hashTree(taskDir);
}

export async function loadTask(taskDir: string): Promise<LoadedTask> {
  const dir = await realpath(taskDir);
  const spec = TaskSpecSchema.parse(JSON.parse(await readFile(join(dir, 'task.json'), 'utf8')));
  const instruction = await readFile(join(dir, spec.instructionFile), 'utf8');
  const graderDir = resolve(dir, spec.verifier.graderDir);
  if (!inside(dir, graderDir) || !existsSync(graderDir)) throw new TaskIntegrityError(`${spec.id}: grader directory ${spec.verifier.graderDir} missing`);
  if (spec.repo.kind === 'inline') {
    const repoDir = resolve(dir, spec.repo.dir);
    if (inside(repoDir, graderDir) || inside(graderDir, repoDir)) {
      throw new TaskIntegrityError(`${spec.id}: grader assets must not live inside the seed repository (or vice versa)`);
    }
  }
  const referencePatch = spec.referencePatch ? await readFile(join(dir, spec.referencePatch), 'utf8') : null;
  if (spec.tags.includes('sealed') && spec.split !== 'sealed') {
    throw new TaskIntegrityError(`${spec.id}: 'sealed' tag on a non-sealed split`);
  }
  return {
    spec,
    dir,
    instruction,
    graderDir,
    referencePatch,
    checksum: await taskChecksum(dir),
    sealed: spec.split === 'sealed',
  };
}

export interface LoadedHoldout {
  root: string;
  index: HoldoutIndex;
  tasks: LoadedTask[];
}

/** Loads a holdout and enforces the frozen checksums recorded in its index. */
export async function loadHoldout(root: string): Promise<LoadedHoldout> {
  const absolute = await realpath(root);
  const index = HoldoutIndexSchema.parse(JSON.parse(await readFile(join(absolute, 'holdout.json'), 'utf8')));
  const tasks: LoadedTask[] = [];
  for (const entry of index.tasks) {
    const task = await loadTask(join(absolute, 'tasks', entry.id));
    if (task.spec.id !== entry.id) throw new TaskIntegrityError(`task directory ${entry.id} declares id ${task.spec.id}`);
    if (entry.checksum !== null && entry.checksum !== task.checksum) {
      throw new TaskIntegrityError(`${entry.id}: checksum ${task.checksum} differs from the frozen ${entry.checksum}`);
    }
    if (index.frozenAt !== null && entry.checksum === null) throw new TaskIntegrityError(`${entry.id}: frozen holdout without a task checksum`);
    tasks.push(task);
  }
  return { root: absolute, index, tasks };
}

export interface BaseRepo {
  path: string;
  baseSha: string;
}

/**
 * Creates the immutable base repository for a task under `workRoot`: inline
 * seeds become a single deterministic commit (no history to mine); git
 * sources are cloned, detached at the base SHA and sanitized (only one ref,
 * no remotes, unreachable objects pruned), then audited.
 */
export async function materializeBaseRepo(task: LoadedTask, workRoot: string): Promise<BaseRepo> {
  const path = join(workRoot, 'base', task.spec.id);
  await mkdir(path, { recursive: true });
  if (task.spec.repo.kind === 'inline') {
    await cp(join(task.dir, task.spec.repo.dir), path, { recursive: true });
    await git(path, ['init', '--quiet']);
    await git(path, ['add', '-A']);
    await git(path, ['commit', '--quiet', '--no-verify', '-m', `eval base: ${task.spec.id}`]);
  } else {
    await git(workRoot, ['clone', '--quiet', '--no-checkout', task.spec.repo.url, path], { timeoutMs: 600_000 });
    await git(path, ['checkout', '--quiet', '--detach', task.spec.repo.baseSha]);
    await sanitizeHistory(path, task.spec.repo.baseSha);
  }
  const baseSha = (await git(path, ['rev-parse', 'HEAD'])).trim();
  const issues = await auditRepoHistory(path, baseSha);
  if (issues.length > 0) throw new TaskIntegrityError(`${task.spec.id}: base repository history is not sanitized: ${issues.join('; ')}`);
  return { path, baseSha };
}

async function sanitizeHistory(repo: string, baseSha: string): Promise<void> {
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname)'])).split('\n').filter(Boolean);
  for (const ref of refs) await git(repo, ['update-ref', '--no-deref', '-d', ref]);
  const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
  for (const remote of remotes) await git(repo, ['remote', 'remove', remote]);
  await git(repo, ['update-ref', 'refs/heads/main', baseSha]);
  await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(repo, ['reflog', 'expire', '--expire=now', '--all']);
  await git(repo, ['gc', '--quiet', '--prune=now']);
}

/**
 * Contamination control: the agent's starting repository must not contain
 * any commit after the base (no fixing commit, stray refs, stashes or
 * remotes), mirroring SWE-bench Pro V2's sanitized history.
 */
export async function auditRepoHistory(repo: string, baseSha: string): Promise<string[]> {
  const issues: string[] = [];
  const refs = (await git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).split('\n').filter(Boolean);
  for (const line of refs) {
    const [ref, sha] = line.split(' ');
    if (!ref || !sha) continue;
    if (ref === 'refs/stash') {
      issues.push('stash present');
      continue;
    }
    if (sha === baseSha) continue;
    const ancestor = await gitTry(repo, ['merge-base', '--is-ancestor', sha, baseSha]);
    if (ancestor.code !== 0) issues.push(`${ref} points past the base commit`);
  }
  const remotes = (await git(repo, ['remote'])).split('\n').filter(Boolean);
  if (remotes.length > 0) issues.push(`remotes configured: ${remotes.join(', ')}`);
  return issues;
}

/**
 * A fresh, independent checkout for one trial: a full clone of the base repo
 * (no shared object store), detached at the base SHA, with no remote — so
 * nothing from another trial or from the grader can leak in.
 */
export async function cloneForTrial(base: BaseRepo, dest: string): Promise<void> {
  await git(resolve(dest, '..'), ['clone', '--quiet', '--no-hardlinks', base.path, dest]);
  await git(dest, ['checkout', '--quiet', '--detach', base.baseSha]);
  await git(dest, ['remote', 'remove', 'origin']);
}

/** True when `candidate` (after symlink resolution) is inside `parent`. */
export async function isInside(parent: string, candidate: string): Promise<boolean> {
  const [p, c] = await Promise.all([realpath(parent), realpath(candidate)]);
  return inside(p, c);
}
