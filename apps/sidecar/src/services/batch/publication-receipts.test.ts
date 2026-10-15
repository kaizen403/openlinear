import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createBatchState } from '@openlinear/execution-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hooks = vi.hoisted(() => ({ beforeRename: vi.fn(async () => undefined) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, rename: async (...args: Parameters<typeof original.rename>) => { await hooks.beforeRename(); return original.rename(...args); } };
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
describe('durable batch receipts on the filesystem', () => {
  let root: string;
  let publication: typeof import('./publication');
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ol-batch-receipt-'));
    vi.stubEnv('REPOS_DIR', root); vi.resetModules();
    hooks.beforeRename.mockReset().mockResolvedValue(undefined);
    publication = await import('./publication');
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
  function batch() {
    return createBatchState({
      id: 'receipt-attempt', projectId: 'repo', mode: 'queue', taskIds: ['task'],
      mainRepoPath: join(root, 'repo', '.main'), accessToken: 'fixture-private-token', userId: 'user',
      settings: { maxConcurrent: 1, autoApprove: false, stopOnFailure: false, conflictBehavior: 'fail' },
    });
  }

  it('stores a private receipt outside the worktree and redacts errors', async () => {
    const current = batch();
    current.tasks[0].error = 'fixture-private-token ' + encodeURIComponent(current.accessToken!) + ' ' + Buffer.from(current.accessToken!).toString('base64');
    await publication.writeBatchReceipt(current, 'failed', current.tasks[0].error);
    const path = current.publication!.receiptPath!;
    expect(path).toBe(join(await realpath(root), 'repo', '.receipts', 'batch-receipt-attempt.json'));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('fixture-private-token');
    expect(raw).not.toContain(Buffer.from(current.accessToken!).toString('base64'));
    expect(raw).toContain('[REDACTED]');
    expect(JSON.parse(raw)).toMatchObject({ schemaVersion: 1, batchId: current.id, userId: 'user', publication: { phase: 'failed' } });
  });

  it('serializes an older writer before cancellation and preserves a late accepted PR', async () => {
    const current = batch(); current.status = 'running';
    const reached = gate(); const release = gate();
    hooks.beforeRename.mockImplementationOnce(async () => { reached.resolve(); await release.promise; });
    const older = publication.writeBatchReceipt(current, 'committed');
    await reached.promise;
    current.status = 'cancelled'; current.tasks[0].status = 'cancelled';
    current.prUrl = 'https://github.com/acme/repo/pull/1';
    const cancellation = publication.writeBatchReceipt(current, 'pr_created');
    await Promise.resolve();
    expect(hooks.beforeRename).toHaveBeenCalledTimes(1);
    release.resolve(); await Promise.all([older, cancellation]);
    const receipt = JSON.parse(await readFile(current.publication!.receiptPath!, 'utf8'));
    expect(receipt).toMatchObject({ status: 'cancelled', prUrl: current.prUrl, publication: { phase: 'cancelled' }, tasks: [{ status: 'cancelled' }] });
  });
});
