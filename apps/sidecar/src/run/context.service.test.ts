import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isTerminalRunState } from '@openlinear/execution-core';
import type { RepositoryContextInput, RepositoryContextResult } from '../context';
import { DurableRunJournal } from '../journal/durable';
import { RunService, type RunServiceOptions } from './service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeWorkspace, fakeCredential, fakeSnapshot } from './test-support';

/**
 * W16b in the run engine: the repository context port is asked once per
 * first run (with the worktree, its base commit, the repository key and the
 * task text), its section is appended to the first prompt and its receipt
 * logged; no section = the prompt as before.
 */

const roots: string[] = [];
const services: RunService[] = [];

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TEST_OPTIONS: Partial<RunServiceOptions> = {
  heartbeatMs: 3_600_000,
  retryBaseMs: 5,
  retryMaxMs: 20,
  relayDelayMs: 0,
  interruptGraceMs: 0,
  watchdogIntervalMs: 20,
  watchdog: { transportMs: 1e9, noProgressMs: 1e9, wallClockMs: 1e9 },
};

const RECEIPT = { sha: 'a'.repeat(40), indexedFiles: 42, contentFiles: 40, cacheHit: true, reusedBlobs: 0, ms: 12 };

function harness(answer: (input: RepositoryContextInput) => RepositoryContextResult) {
  const root = mkdtempSync(join(tmpdir(), 'ol-context-svc-'));
  roots.push(root);
  const cp = new FakeControlPlane();
  cp.snapshot = (taskId) => fakeSnapshot(taskId, { title: 'Fix the avatar upload', description: 'Uploads over 2 MB fail', labels: ['bug'] });
  const host = new FakeRuntimeHost();
  const asked: RepositoryContextInput[] = [];
  const journal = new DurableRunJournal(join(root, 'journal', 'runs-v2.sqlite'));
  const service = new RunService({
    journal,
    controlPlane: cp,
    runtimes: new Map([['opencode', new FakeRuntime(host)]]),
    publication: new FakePublication(),
    workspace: new FakeWorkspace(join(root, 'worktrees')),
    events: { publish: () => undefined },
    repositoryContext: async (input) => {
      asked.push(input);
      return answer(input);
    },
    options: TEST_OPTIONS,
  });
  services.push(service);
  return { cp, host, journal, service, asked };
}

async function settled(journal: DurableRunJournal, runId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(journal.get(runId) && isTerminalRunState(journal.get(runId)?.state ?? 'queued'))) {
    if (Date.now() > deadline) throw new Error('run did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('W16b repository context in the first prompt', () => {
  it('appends the section to the prompt and logs the receipt', async () => {
    const section = '<untrusted-repository-content>\n1| src/upload.ts\n</untrusted-repository-content>';
    const h = harness(() => ({ section, citations: [{ path: 'src/upload.ts', startLine: 1, endLine: 20, score: 3, reasons: ['name'], matched: ['upload'] }], receipt: RECEIPT, reason: null }));
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(h.journal, started.runId);

    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({
      worktreePath: h.journal.get(started.runId)?.workspace?.worktreePath,
      repositoryKey: expect.any(String),
      task: { title: 'Fix the avatar upload', description: 'Uploads over 2 MB fail', labels: ['bug'] },
    });
    const [session] = [...h.host.sessions.values()];
    const prompt = h.host.promptTexts.get(session?.id ?? '')?.[0] ?? '';
    expect(prompt.startsWith('Fix the avatar upload\n\nUploads over 2 MB fail\n\nLabels: bug\n\n<untrusted-repository-content>')).toBe(true);
    expect(h.service.logsFor('task-1').map((entry) => entry.message)).toContain('Repository context: 1 related file at aaaaaaaaaaaa (cached index 42 files, 12 ms)');
  });

  it('W19b: project knowledge from the snapshot comes before the repository context, and the log names the revisions', async () => {
    const h = harness(() => ({ section: '<untrusted-repository-content>\n1| x\n</untrusted-repository-content>', citations: [], receipt: RECEIPT, reason: null }));
    h.cp.snapshot = (taskId) => fakeSnapshot(taskId, {
      title: 'Fix the avatar upload',
      description: null,
      knowledge: [
        { id: 'k1', version: 3, kind: 'convention', title: 'Use pnpm', body: 'Never npm or yarn.' },
        { id: 'k2', version: 1, kind: 'procedure', title: 'Before a PR', body: 'Run pnpm lint and pnpm test.' },
      ],
    });
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(h.journal, started.runId);

    const [session] = [...h.host.sessions.values()];
    expect(h.host.promptTexts.get(session?.id ?? '')?.[0]).toBe([
      'Fix the avatar upload',
      '',
      '## Project knowledge',
      'Written or approved by the team for this project. Follow it unless the task says otherwise.',
      '',
      '### Use pnpm (convention)',
      'Never npm or yarn.',
      '',
      '### Before a PR (procedure)',
      'Run pnpm lint and pnpm test.',
      '',
      '<untrusted-repository-content>\n1| x\n</untrusted-repository-content>',
    ].join('\n'));
    const log = h.service.logsFor('task-1').find((entry) => entry.message === 'Project knowledge: 2 entries given to the agent');
    expect(log?.details).toBe('Use pnpm (v3), Before a PR (v1)');
    expect(h.service.describe('task-1')?.knowledge).toEqual([
      { id: 'k1', version: 3, kind: 'convention', title: 'Use pnpm' },
      { id: 'k2', version: 1, kind: 'procedure', title: 'Before a PR' },
    ]);
  });

  it('without a section the prompt is unchanged and the log says why', async () => {
    const h = harness(() => ({ section: null, citations: [], receipt: { ...RECEIPT, sha: null }, reason: 'nothing related was found' }));
    h.cp.addTask('task-1');
    const started = await h.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(h.journal, started.runId);

    const [session] = [...h.host.sessions.values()];
    expect(h.host.promptTexts.get(session?.id ?? '')?.[0]).toBe('Fix the avatar upload\n\nUploads over 2 MB fail\n\nLabels: bug');
    expect(h.service.logsFor('task-1').map((entry) => entry.message)).toContain('Repository context: none (nothing related was found)');
  });
});
