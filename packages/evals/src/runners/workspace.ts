import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { FileEffect } from '../trajectory/types';
import { git } from '../util/git';

/**
 * The produced artifact: every change in the worktree (tracked, untracked
 * and deleted files) relative to the base commit, as a binary-safe git diff.
 * Captured identically for every configuration after its process tree has
 * stopped.
 */
export async function capturePatch(worktree: string, baseSha: string): Promise<string> {
  await git(worktree, ['add', '-A']);
  return git(worktree, ['diff', '--cached', '--binary', '--no-color', '--no-ext-diff', baseSha]);
}

/** Applies a recorded file effect inside `root`, refusing any path that escapes it. */
export async function applyEffect(root: string, effect: FileEffect): Promise<void> {
  const base = await realpath(root);
  const target = resolve(base, effect.path);
  const rel = relative(base, target);
  if (rel.startsWith('..') || rel.startsWith(sep) || rel.split(sep).includes('.git')) {
    throw new Error(`effect path escapes the worktree: ${effect.path}`);
  }
  if (effect.op === 'delete') {
    await rm(target, { force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, effect.content ?? '');
}

/**
 * Turns a finished worktree into replayable effects (final contents of every
 * changed path), so a real run's trajectory can be replayed offline later.
 */
export async function effectsFromWorktree(worktree: string, baseSha: string, afterEvent: number): Promise<FileEffect[]> {
  await git(worktree, ['add', '-A']);
  const out = await git(worktree, ['diff', '--cached', '--name-status', '--no-renames', '-z', baseSha]);
  const parts = out.split('\0').filter(Boolean);
  const effects: FileEffect[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] as string;
    const path = parts[i + 1] as string;
    if (status.startsWith('D')) effects.push({ afterEvent, path, op: 'delete' });
    else effects.push({ afterEvent, path, op: 'write', content: await readFile(join(worktree, path), 'utf8') });
  }
  return effects;
}
