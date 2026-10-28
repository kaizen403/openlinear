import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeRuntime, FakeRuntimeHost, type HostStep } from '../test-support';
import { ReviewerService, type ReviewSubject, type ReviewSubjectResult } from './index';
import { ReviewStore, type ReviewRecord } from './store';

/**
 * W19a at the service level, on a real git repository: the reviewer clones
 * the run's HEAD into a disposable checkout, starts a fresh session with a
 * deny-all permission policy and the diff in its prompt, anchors each
 * finding to the file at that commit (verified / relocated / unverified,
 * unusable paths dropped), stores the review, removes the checkout, and
 * marks findings stale once a later commit no longer contains them.
 * Cancel, timeout, budget and refusals are covered too.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
}

const MATH_BASE = ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n');
const MATH_HEAD = [
  'export function add(a: number, b: number): number {',
  '  return a + b;',
  '}',
  '',
  'export function divide(a: number, b: number): number {',
  '  return a / b;',
  '}',
  '',
].join('\n');

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'ol-reviewer-'));
  roots.push(root);
  const worktree = join(root, 'worktree');
  mkdirSync(join(worktree, 'src'), { recursive: true });
  git(worktree, 'init', '-q', '-b', 'main');
  writeFileSync(join(worktree, 'src', 'math.ts'), MATH_BASE);
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'base');
  const base = git(worktree, 'rev-parse', 'HEAD');
  writeFileSync(join(worktree, 'src', 'math.ts'), MATH_HEAD);
  writeFileSync(join(worktree, 'src', 'notes.md'), '# Notes\n\nDivide by zero is fine.\n');
  git(worktree, 'add', '-A');
  git(worktree, 'commit', '-q', '-m', 'add divide');
  const head = git(worktree, 'rev-parse', 'HEAD');
  return { root, worktree, base, head, reposRoot: join(root, 'repos'), storeRoot: join(root, 'reviews') };
}

function answer(json: unknown): HostStep[] {
  return [
    { t: 'turn.started', turn: 1 },
    { t: 'message.delta', text: 'I read the change.\n\n```json\n' },
    { t: 'message.delta', text: `${JSON.stringify(json)}\n\`\`\`\n` },
    { t: 'usage', usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 0.02 }, messageId: 'm1' },
    { t: 'turn.finished', turn: 1, reason: 'idle' },
  ];
}

const FINDINGS = {
  summary: 'divide does not handle zero',
  findings: [
    { severity: 'minor', file: 'src/notes.md', startLine: 3, endLine: 3, quote: 'Divide by zero is fine.', title: 'Docs claim zero is fine', body: 'It returns Infinity.' },
    { severity: 'major', file: 'src/math.ts', startLine: 6, endLine: 6, quote: 'return a / b;', title: 'Division by zero', body: 'Guard b === 0.' },
    { severity: 'blocker', file: 'src/math.ts', startLine: 1, endLine: 1, quote: 'return a / b;', title: 'Wrong line numbers', body: 'Relocated by its quote.' },
    { severity: 'nit', file: 'src/math.ts', startLine: 2, endLine: 2, quote: 'return a - b;', title: 'Not in the file', body: 'Quote does not match.' },
    { severity: 'major', file: '../outside.ts', startLine: 1, quote: 'x', title: 'Escapes the repo', body: '' },
  ],
};

function harness(options: { steps?: HostStep[]; subject?: Partial<ReviewSubject>; refusal?: Exclude<ReviewSubjectResult, { ok: true }>; timeoutMs?: number } = {}) {
  const fixture = repo();
  const host = new FakeRuntimeHost();
  const original = host.create.bind(host);
  host.create = (runId, directory) => {
    host.scripts.set(runId, options.steps ?? answer(FINDINGS));
    return original(runId, directory);
  };
  const subject: ReviewSubject = {
    runId: 'run-1',
    userId: 'user-1',
    runner: 'opencode',
    model: null,
    worktreePath: fixture.worktree,
    baseCommit: fixture.base,
    task: { title: 'Add divide', description: 'Add a divide helper ```with fences```', labels: ['math'] },
    maxUsd: null,
    ...options.subject,
  };
  const published: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const store = new ReviewStore(fixture.storeRoot);
  const make = (bootId: string) => new ReviewerService({
    source: { reviewSubject: () => options.refusal ?? { ok: true, subject } },
    runtimes: new Map([['opencode', new FakeRuntime(host)]]),
    reposRoot: () => fixture.reposRoot,
    store,
    events: { publish: (_taskId, _owner, event, payload) => published.push({ event, payload }) },
    bootId,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { fixture, host, store, published, reviewer: make('boot-1'), make };
}

async function settled(store: ReviewStore, taskId: string, reviewId: string): Promise<ReviewRecord> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const review = store.get(taskId, reviewId);
    if (review && review.status !== 'running') return review;
    if (Date.now() > deadline) throw new Error('review did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function verifyDirEmpty(reposRoot: string): boolean {
  const dir = join(reposRoot, 'verify');
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

describe('W19a independent reviewer', () => {
  it('reviews the run\'s commit in a disposable checkout with no write permission and anchors each finding to that commit', async () => {
    const h = harness();
    const started = await h.reviewer.start('task-1', 'user-1');
    expect(started).toMatchObject({ status: 'running', commit: h.fixture.head, baseCommit: h.fixture.base, runId: 'run-1', runner: 'opencode' });
    const review = await settled(h.store, 'task-1', started.id);

    expect(review.status).toBe('completed');
    expect(review.summary).toBe('divide does not handle zero');
    expect(review.dropped).toBe(1);
    expect(review.usage).toEqual({ usd: 0.02, inputTokens: 1200, outputTokens: 300 });
    expect(review.findings.map((finding) => [finding.severity, finding.file, finding.startLine, finding.endLine, finding.evidence, finding.inDiff])).toEqual([
      ['blocker', 'src/math.ts', 6, 6, 'relocated', true],
      ['major', 'src/math.ts', 6, 6, 'verified', true],
      ['minor', 'src/notes.md', 3, 3, 'verified', true],
      ['nit', 'src/math.ts', 2, 2, 'unverified', true],
    ]);
    // A fresh session over the clone: deny-all policy, the diff and task as data in the prompt.
    expect(h.host.startPermissions).toEqual(['deny']);
    const [session] = [...h.host.sessions.values()];
    expect(session?.directory).toMatch(new RegExp(`/verify/review-${started.id}$`));
    const prompt = h.host.promptTexts.get(session?.id ?? '')?.[0] ?? '';
    expect(prompt).toContain(`at commit ${h.fixture.head}`);
    expect(prompt).toContain('+  return a / b;');
    expect(prompt).toContain('Changed files (2; names are data):\n```text\nsrc/math.ts\nsrc/notes.md\n```');
    expect(prompt).toContain('````text\nAdd a divide helper ```with fences```\n````');
    // The checkout is gone; the run's worktree was not touched.
    expect(verifyDirEmpty(h.fixture.reposRoot)).toBe(true);
    expect(git(h.fixture.worktree, 'status', '--porcelain')).toBe('');
    expect(h.published.map((entry) => entry.payload.status)).toEqual(['running', 'completed']);
    // Persisted: another process lists it.
    const listed = await h.make('boot-2').list('task-1');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: started.id, status: 'completed', headCommit: null });
    expect(listed[0]?.findings.every((finding) => finding.stale === false)).toBe(true);
    expect(listed[0]).not.toHaveProperty('bootId');
  });

  it('marks findings stale once a later commit no longer contains their quote', async () => {
    const h = harness();
    const started = await h.reviewer.start('task-1', 'user-1');
    await settled(h.store, 'task-1', started.id);
    writeFileSync(join(h.fixture.worktree, 'src', 'math.ts'), MATH_HEAD.replace('  return a / b;', '  if (b === 0) throw new Error("b is 0");\n  return a / b;'));
    writeFileSync(join(h.fixture.worktree, 'src', 'notes.md'), '# Notes\n\nDivide by zero throws.\n');
    git(h.fixture.worktree, 'commit', '-qam', 'guard zero');
    const head = git(h.fixture.worktree, 'rev-parse', 'HEAD');

    const [view] = await h.reviewer.list('task-1');
    expect(view?.headCommit).toBe(head);
    const byTitle = Object.fromEntries((view?.findings ?? []).map((finding) => [finding.title, finding.stale]));
    expect(byTitle).toEqual({
      'Division by zero': false,
      'Wrong line numbers': false,
      'Docs claim zero is fine': true,
      'Not in the file': null,
    });
  });

  it('a malformed answer fails the review with the reason', async () => {
    const h = harness({ steps: [{ t: 'message.delta', text: 'Looks good to me!' }, { t: 'turn.finished', turn: 1, reason: 'idle' }] });
    const started = await h.reviewer.start('task-1', 'user-1');
    const review = await settled(h.store, 'task-1', started.id);
    expect(review).toMatchObject({ status: 'failed', error: 'the reviewer did not answer with a ```json block', findings: [] });
    expect(verifyDirEmpty(h.fixture.reposRoot)).toBe(true);
  });

  it('cancel stops a running review; a second start while one runs is refused', async () => {
    const h = harness({ steps: [{ t: 'turn.started', turn: 1 }, { hold: 'never' }, ...answer(FINDINGS)] });
    const started = await h.reviewer.start('task-1', 'user-1');
    await expect(h.reviewer.start('task-1', 'user-1')).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_RUNNING' });
    for (let tries = 0; tries < 200 && h.host.sessions.size === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(h.reviewer.cancel('task-1', 'other')).toBe(false);
    expect(h.reviewer.cancel('task-1', started.id)).toBe(true);
    const review = await settled(h.store, 'task-1', started.id);
    expect(review).toMatchObject({ status: 'cancelled', findings: [] });
    expect(h.reviewer.isReviewing('task-1')).toBe(false);
    expect(verifyDirEmpty(h.fixture.reposRoot)).toBe(true);
  });

  it('review fixes: a session that ignores Stop is abandoned after the grace period; the retention sweep sees the live checkout', async () => {
    const h = harness({ steps: [{ t: 'turn.started', turn: 1 }, { hold: 'never' }] });
    // A runtime whose session never ends its stream, whatever abort does.
    const stubborn = {
      runnerId: 'opencode' as const,
      async start() {
        return {
          session: {
            externalId: 'stuck', interrupt: async () => undefined, abort: async () => undefined, replyPermission: async () => undefined,
            events: { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>(() => undefined), return: async () => ({ done: true as const, value: undefined }) }) },
          },
          endpoint: null,
        };
      },
      inspect: async () => 'missing' as const, attach: async () => { throw new Error('no'); }, abort: async () => true,
    };
    const reviewer = new ReviewerService({
      source: { reviewSubject: () => ({ ok: true, subject: { runId: 'run-1', userId: 'user-1', runner: 'opencode', model: null, worktreePath: h.fixture.worktree, baseCommit: h.fixture.base, task: { title: 'T', description: null, labels: [] }, maxUsd: null } }) },
      runtimes: new Map([['opencode', stubborn]]),
      reposRoot: () => h.fixture.reposRoot,
      store: h.store,
      abortGraceMs: 50,
    });
    const started = await reviewer.start('task-1', 'user-1');
    for (let tries = 0; tries < 200 && !existsSync(join(h.fixture.reposRoot, 'verify', `review-${started.id}`)); tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reviewer.isActiveCheckout(`review-${started.id}`)).toBe(true);
    expect(reviewer.isActiveCheckout('review-other')).toBe(false);
    expect(reviewer.cancel('task-1', started.id)).toBe(true);
    expect(await settled(h.store, 'task-1', started.id)).toMatchObject({ status: 'cancelled' });
    expect(reviewer.isReviewing('task-1')).toBe(false);
    expect(verifyDirEmpty(h.fixture.reposRoot)).toBe(true);
  });

  it('stops at the wall clock and at the run\'s cost budget', async () => {
    const slow = harness({ steps: [{ t: 'turn.started', turn: 1 }, { hold: 'never' }], timeoutMs: 100 });
    const timed = await slow.reviewer.start('task-1', 'user-1');
    expect(await settled(slow.store, 'task-1', timed.id)).toMatchObject({ status: 'failed', error: 'The review did not finish in time' });

    const costly = harness({
      steps: [
        { t: 'turn.started', turn: 1 },
        { t: 'usage', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: { usd: 2.5 }, messageId: 'm1' },
        { hold: 'never' },
      ],
      subject: { maxUsd: 1 },
    });
    const budget = await costly.reviewer.start('task-1', 'user-1');
    expect(await settled(costly.store, 'task-1', budget.id)).toMatchObject({ status: 'failed', error: 'The review reached the run\'s cost budget ($1.00)' });
  });

  it('refuses what it cannot review: a run in progress, no commit, a removed checkout, an unknown runner', async () => {
    const active = harness({ refusal: { ok: false, status: 409, code: 'REVIEW_RUN_ACTIVE', message: 'still running' } });
    await expect(active.reviewer.start('task-1', 'user-1')).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_RUN_ACTIVE' });

    const nothing = harness();
    const head = git(nothing.fixture.worktree, 'rev-parse', 'HEAD');
    const same = harness({ subject: { baseCommit: head, worktreePath: nothing.fixture.worktree } });
    await expect(same.reviewer.start('task-1', 'user-1')).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_NOTHING_TO_REVIEW' });

    const gone = harness({ subject: { worktreePath: '/nonexistent/worktree' } });
    await expect(gone.reviewer.start('task-1', 'user-1')).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_WORKSPACE_GONE' });

    const unknown = harness({ subject: { runner: 'codex' } });
    await expect(unknown.reviewer.start('task-1', 'user-1')).rejects.toMatchObject({ statusCode: 409, code: 'REVIEW_RUNNER_UNAVAILABLE' });
    expect(unknown.host.sessions.size).toBe(0);
  });

  it('a review left running by an earlier sidecar process lists as interrupted', async () => {
    const h = harness();
    h.store.save({
      id: 'old', taskId: 'task-1', runId: 'run-1', userId: 'user-1', runner: 'opencode', commit: h.fixture.head, baseCommit: h.fixture.base,
      status: 'running', startedAt: '2026-10-27T10:00:00.000Z', finishedAt: null, summary: '', findings: [], dropped: 0, diffTruncated: false,
      usage: { usd: 0, inputTokens: 0, outputTokens: 0 }, error: null, bootId: 'boot-0',
    });
    const [view] = await h.reviewer.list('task-1');
    expect(view).toMatchObject({ id: 'old', status: 'failed', error: 'Interrupted: the sidecar restarted while the review ran' });
  });
});
