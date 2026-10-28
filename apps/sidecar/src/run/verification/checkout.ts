import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { execGit } from '../../services/git-credentials';

/**
 * W11a pristine checkout: the commit under verification, materialized in a
 * fresh directory that shares nothing writable with the agent's worktree.
 *
 * `git clone --no-checkout --shared` from the agent's worktree (objects via
 * an alternates file, read-only; no object copy) and then a detached checkout
 * of the exact commit. The agent's changes reach it only through that
 * commit: untracked files, the index, stashes, hooks and the agent's
 * repository config are not part of a clone. The source repository is never
 * mutated (no `git worktree add` into the user's or the mirror's metadata).
 *
 * Layout: `<repos>/verify/<runId>` (deterministic, so a restarted sidecar
 * removes a half-built checkout before re-running).
 */

export interface PristineCheckout {
  path: string;
  commit: string;
  /** The objects directory the clone borrows (read-only inside the sandbox), if any. */
  alternateObjects: string[];
}

const SHA = /^[0-9a-f]{40,64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function verifyRoot(reposRoot: string): string {
  return join(resolve(reposRoot), 'verify');
}

export function pristineCheckoutPath(reposRoot: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error('[verify] invalid run id');
  return join(verifyRoot(reposRoot), runId);
}

function assertInside(root: string, target: string): void {
  const rel = relative(root, resolve(target));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('[verify] checkout path escapes its root');
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error('[verify] checkout path is a symlink');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

export function removePristineCheckout(reposRoot: string, path: string): void {
  const root = verifyRoot(reposRoot);
  assertInside(root, path);
  rmSync(path, { recursive: true, force: true });
}

function readAlternates(checkout: string): string[] {
  const file = join(checkout, '.git', 'objects', 'info', 'alternates');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'))
    .map((line) => {
      try {
        return realpathSync(line);
      } catch {
        return line;
      }
    });
}

export async function createPristineCheckout(input: { reposRoot: string; runId: string; source: string; commit: string }): Promise<PristineCheckout> {
  if (!SHA.test(input.commit)) throw new Error('[verify] invalid commit id');
  const root = verifyRoot(input.reposRoot);
  const path = pristineCheckoutPath(input.reposRoot, input.runId);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertInside(root, path);
  // A checkout left by a crashed attempt is never reused: rebuild from scratch.
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  // The commit must exist in the source (it is the run's own candidate commit).
  await execGit(['-C', input.source, 'cat-file', '-e', `${input.commit}^{commit}`]);
  // A local clone is the `file` transport, which the hardening disables by
  // default (only https is allowed); re-enable it for this one call, whose
  // source is the run's own checkout. No submodules, no tags, no checkout yet.
  await execGit(['-c', 'protocol.file.allow=always', 'clone', '--quiet', '--no-checkout', '--shared', '--no-tags', '--', input.source, path]);
  try {
    await execGit(['-C', path, '-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', '--force', input.commit, '--']);
    const { stdout } = await execGit(['-C', path, 'rev-parse', 'HEAD']);
    if (stdout.trim() !== input.commit) throw new Error(`[verify] checkout is at ${stdout.trim().slice(0, 12)}, expected ${input.commit.slice(0, 12)}`);
  } catch (error) {
    rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return { path: realpathSync(path), commit: input.commit, alternateObjects: readAlternates(path) };
}
