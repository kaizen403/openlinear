import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BaseRepo } from '../tasks/holdout';
import { cloneForTrial } from '../tasks/holdout';
import type { LoadedTask } from '../tasks/types';
import { gitTry } from '../util/git';
import { baseEnv, runCommand } from '../util/proc';

/**
 * Verifier contract (PRD §10 "independent grading"):
 * 1. the agent's process tree is already stopped and its patch captured;
 * 2. a pristine checkout of the base commit is created outside every agent
 *    worktree;
 * 3. the patch is applied there (a patch that does not apply fails);
 * 4. the task's grader assets — stored only in the task directory — are
 *    copied over the checkout (overwriting any test the agent edited);
 * 5. the verifier argv runs with a minimal environment and a timeout.
 * The agent's own claims and its own test runs are never a success signal.
 */

export type GradeStatus = 'pass' | 'fail' | 'error';

export interface GradeResult {
  status: GradeStatus;
  /** pass | tests-failed | patch-does-not-apply | verifier-timeout | verifier-spawn-failed | empty-patch */
  reason: string;
  patchApplied: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  /** Identifies the grader: the task checksum covers the grader assets. */
  verifierRevision: string;
}

export interface GradeInput {
  task: LoadedTask;
  base: BaseRepo;
  patch: string;
  /** Scratch root for the pristine checkout (removed afterwards). */
  workRoot: string;
  timeoutMs?: number;
  keepCheckout?: boolean;
}

const tail = (text: string, max = 4000) => (text.length > max ? text.slice(text.length - max) : text);

export async function gradePatch(input: GradeInput): Promise<GradeResult> {
  const started = Date.now();
  const { task } = input;
  const verifierRevision = task.checksum;
  await mkdir(input.workRoot, { recursive: true });
  const scratch = await mkdtemp(join(input.workRoot, `grade-${task.spec.id}-`));
  const checkout = join(scratch, 'pristine');
  const done = (status: GradeStatus, reason: string, extra: Partial<GradeResult> = {}): GradeResult => ({
    status,
    reason,
    patchApplied: false,
    exitCode: null,
    durationMs: Date.now() - started,
    stdoutTail: '',
    stderrTail: '',
    verifierRevision,
    ...extra,
  });
  try {
    await cloneForTrial(input.base, checkout);
    let patchApplied = false;
    if (input.patch.trim()) {
      const patchFile = join(scratch, 'candidate.patch');
      await writeFile(patchFile, input.patch.endsWith('\n') ? input.patch : `${input.patch}\n`);
      const applied = await gitTry(checkout, ['apply', '--whitespace=nowarn', '--binary', patchFile]);
      if (applied.code !== 0) return done('fail', 'patch-does-not-apply', { stderrTail: tail(applied.stderr) });
      patchApplied = true;
    }
    const target = resolve(checkout, task.spec.verifier.copyInto);
    await cp(task.graderDir, target, { recursive: true, force: true });
    const result = await runCommand(task.spec.verifier.command[0] as string, task.spec.verifier.command.slice(1), {
      cwd: checkout,
      env: baseEnv({ HOME: scratch, TMPDIR: scratch, NODE_OPTIONS: '', CI: '1' }),
      timeoutMs: input.timeoutMs ?? task.spec.verifier.timeoutMs,
      killGraceMs: 1000,
    });
    const extra = { patchApplied, exitCode: result.code, stdoutTail: tail(result.stdout), stderrTail: tail(result.stderr) };
    if (result.spawnError) return done('error', 'verifier-spawn-failed', { ...extra, stderrTail: result.spawnError });
    if (result.timedOut) return done('error', 'verifier-timeout', extra);
    if (result.code === 0) return done('pass', 'pass', extra);
    return done('fail', patchApplied ? 'tests-failed' : 'empty-patch', extra);
  } catch (error) {
    return done('error', `verifier-internal: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!input.keepCheckout) await rm(scratch, { recursive: true, force: true });
  }
}

export interface TaskGateResult {
  taskId: string;
  referencePasses: boolean;
  emptyPatchFails: boolean;
  ok: boolean;
  reference: GradeResult | null;
  empty: GradeResult;
}

/**
 * Reference and empty-patch gates (as SWE-bench Pro V2's oracle/nop gates):
 * a task is only usable when its reference solution passes and doing nothing
 * fails. Tasks failing either gate are excluded before any system runs.
 */
export async function checkTaskGates(task: LoadedTask, base: BaseRepo, workRoot: string): Promise<TaskGateResult> {
  const empty = await gradePatch({ task, base, patch: '', workRoot });
  const reference = task.referencePatch !== null ? await gradePatch({ task, base, patch: task.referencePatch, workRoot }) : null;
  const referencePasses = reference?.status === 'pass';
  const emptyPatchFails = empty.status === 'fail';
  return { taskId: task.spec.id, referencePasses, emptyPatchFails, ok: referencePasses && emptyPatchFails, reference, empty };
}
