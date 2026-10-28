import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isTerminalRunState,
  resolveVerificationManifest,
  summarizeVerification,
  type VerificationCheckResult,
  type VerificationManifest,
  type VerificationResult,
} from '@openlinear/execution-core';
import { DurableRunJournal } from '../journal/durable';
import type { FaultHook } from './faults';
import { RunService, type RunServiceOptions } from './service';
import { FakeControlPlane, FakePublication, FakeRuntime, FakeRuntimeHost, FakeWorkspace, fakeCredential, fakeSnapshot } from './test-support';
import type { RunSnapshot, RunWorkspace } from './types';
import type { VerificationPort, VerificationRunInput } from './verification';

/**
 * W11a at the service level: the manifest is sealed before the prompt, the
 * `verifying` state runs the checks against the candidate commit before any
 * publication effect, the policy decides publication, evidence is journaled
 * and projected once, a crash mid-verification re-runs it (a recorded result
 * is reused), and cancellation keeps the evidence.
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
  relayRetryBaseMs: 5,
  relayRetryMaxMs: 20,
  interruptGraceMs: 0,
  startWaitMs: 10_000,
  watchdogIntervalMs: 20,
  watchdog: { transportMs: 1e9, noProgressMs: 1e9, wallClockMs: 1e9 },
};

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function waitFor<T>(probe: () => T | null | undefined | false, label: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Scripted verification: per-check exit status, optional hold until released or aborted. */
class FakeVerification implements VerificationPort {
  exits: Record<string, number> = {};
  runs = 0;
  manifests = 0;
  hold = false;
  private release: (() => void) | null = null;
  readonly inputs: VerificationRunInput[] = [];

  async resolveManifest(input: { runId: string; snapshot: RunSnapshot; workspace: RunWorkspace }): Promise<VerificationManifest> {
    this.manifests += 1;
    return resolveVerificationManifest({
      projectSettings: input.snapshot.verificationSettings ?? null,
      projectSettingsSha256: null,
      baseCommit: input.workspace.baseCommit ?? null,
      repositoryFile: null,
      autoDetect: () => null,
      hash: sha256,
      now: () => new Date().toISOString(),
    });
  }

  releaseHold(): void {
    this.hold = false;
    this.release?.();
  }

  async run(input: VerificationRunInput): Promise<VerificationResult> {
    this.runs += 1;
    this.inputs.push(input);
    const results: VerificationCheckResult[] = [];
    for (const [index, check] of input.manifest.checks.entries()) {
      input.onProgress?.({ phase: 'start', index, total: input.manifest.checks.length, check });
      if (this.hold && !input.signal.aborted) {
        await new Promise<void>((resolve) => {
          this.release = resolve;
          input.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      const aborted = input.signal.aborted;
      const exitCode = aborted ? null : this.exits[check.id] ?? 0;
      const result: VerificationCheckResult = {
        id: check.id,
        name: check.name,
        required: check.required,
        status: aborted ? 'skipped' : exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        signal: null,
        durationMs: 10,
        timedOut: false,
        network: check.network.mode,
        command: check.argv.join(' '),
        log: { sha256: null, bytes: 0, truncated: false, tail: exitCode ? 'error TS2322: nope' : '', artifact: null },
        detail: aborted ? 'verification was cancelled' : null,
      };
      results.push(result);
      input.onProgress?.({ phase: 'end', index, total: input.manifest.checks.length, check, result });
    }
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      status: input.signal.aborted ? 'error' : summarizeVerification(results),
      commitSha: input.commitSha,
      baseCommit: input.manifest.baseCommit,
      checksHash: input.manifest.checksHash,
      policy: input.manifest.policy,
      source: input.manifest.source,
      runner: input.runner,
      startedAt: now,
      finishedAt: now,
      checks: results,
      environment: { sandboxMode: 'enforce', provider: 'fake', providerVersion: '1', policyHashes: [], platform: 'test', arch: 'test', checkout: 'pristine-clone' },
      detail: input.signal.aborted ? 'verification was cancelled before every check finished' : null,
      warnings: [],
    };
  }
}

const CHECKS = [
  { id: 'typecheck', name: 'Typecheck', run: 'pnpm typecheck' },
  { id: 'unit', name: 'Unit tests', command: ['pnpm', 'test'] },
];

class CrashSignal extends Error {}

function harness(settings: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'ol-verify-svc-'));
  roots.push(root);
  const journalPath = join(root, 'journal', 'runs-v2.sqlite');
  const cp = new FakeControlPlane();
  cp.snapshot = (taskId) => fakeSnapshot(taskId, settings === undefined ? {} : { verificationSettings: settings });
  const host = new FakeRuntimeHost();
  const publication = new FakePublication();
  const workspace = new FakeWorkspace(join(root, 'worktrees'));
  const verification = new FakeVerification();
  const holder: { instance?: { service: RunService; journal: DurableRunJournal } } = {};

  function boot(faults?: FaultHook | null) {
    const journal = new DurableRunJournal(journalPath);
    const service = new RunService({
      journal,
      controlPlane: cp,
      runtimes: new Map([['opencode', new FakeRuntime(host)]]),
      publication,
      workspace,
      verification,
      reposRoot: () => root,
      events: { publish: () => undefined },
      faults: faults ?? null,
      options: TEST_OPTIONS,
    });
    services.push(service);
    holder.instance = { service, journal };
    return { service, journal };
  }

  function crashAt(target: string): FaultHook {
    let fired = false;
    return (phase, point) => {
      if (fired || `${phase}:${point}` !== target || !holder.instance) return;
      fired = true;
      holder.instance.service.stop();
      holder.instance.journal.close();
      throw new CrashSignal(`crashed at ${target}`);
    };
  }

  return { cp, host, publication, workspace, verification, boot, crashAt };
}

async function settled(journal: DurableRunJournal, cp: FakeControlPlane, runId: string, taskId: string): Promise<void> {
  await waitFor(() => {
    const record = journal.get(runId);
    const attempt = cp.attemptFor(taskId);
    return record && isTerminalRunState(record.state) && journal.effects(runId).every((effect) => effect.status !== 'pending')
      && (attempt?.status === 'closed' || attempt?.status === 'released');
  }, `run ${runId} settled`);
}

function states(journal: DurableRunJournal, runId: string): unknown[] {
  return journal.events(runId, 0, 10_000).filter((event) => event.kind === 'run.state').map((event) => event.payload.to);
}

describe('W11a verifying state', () => {
  it('seals the manifest before the prompt, verifies the candidate commit before any publication effect, then publishes (warn, all pass)', async () => {
    const h = harness({ policy: 'warn', checks: CHECKS });
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');

    const record = journal.get(started.runId);
    expect(record?.state).toBe('succeeded');
    expect(record?.verification?.manifest).toMatchObject({ policy: 'warn', source: 'project' });
    expect(record?.verification?.manifest.checks.map((check) => check.id)).toEqual(['typecheck', 'unit']);
    expect(states(journal, started.runId)).toEqual(['running', 'verifying', 'finishing', 'succeeded']);
    const kinds = journal.effects(started.runId).map((effect) => effect.kind);
    expect(kinds.indexOf('verify.run')).toBeGreaterThan(kinds.indexOf('git.commit'));
    expect(kinds.indexOf('verify.run')).toBeLessThan(kinds.indexOf('git.push'));
    expect(kinds.indexOf('verification.record')).toBeLessThan(kinds.indexOf('git.push'));
    expect(journal.effects(started.runId).every((effect) => effect.status === 'confirmed')).toBe(true);

    const commit = h.publication.commits[0]?.sha;
    expect(h.verification.inputs[0]?.commitSha).toBe(commit);
    expect([...h.cp.verifications.values()]).toEqual([expect.objectContaining({ commitSha: commit, status: 'passed', publication: 'allowed', policy: 'warn' })]);
    expect(h.cp.tasks.get('task-1')?.outcome).toMatch(/verified on [0-9a-f]{12} \(2\/2 required checks\)/);
    expect(service.describe('task-1')?.verification).toMatchObject({ status: 'passed', commit, publication: 'allowed', checks: [{ id: 'typecheck', status: 'passed' }, { id: 'unit', status: 'passed' }] });
    expect(service.logsFor('task-1').some((entry) => entry.message.startsWith('Verification sealed: 2 checks from project settings'))).toBe(true);
  });

  it('require-pass: a failing required check blocks publication; the run fails with the work retained and the evidence recorded', async () => {
    const h = harness({ policy: 'require-pass', checks: CHECKS });
    h.verification.exits = { unit: 1 };
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');

    expect(journal.get(started.runId)?.state).toBe('failed');
    expect(states(journal, started.runId)).toEqual(['running', 'verifying', 'failed']);
    expect(h.publication.pushCalls).toBe(0);
    expect(h.publication.prPosts).toBe(0);
    expect(journal.effects(started.runId).map((effect) => effect.kind)).not.toContain('git.push');
    expect([...h.cp.verifications.values()]).toEqual([expect.objectContaining({ status: 'failed', publication: 'blocked', policy: 'require-pass' })]);
    expect(h.cp.tasks.get('task-1')?.status).not.toBe('done');
    expect(h.cp.tasks.get('task-1')?.outcome).toMatch(/Verification failed on [0-9a-f]{12}: 1 of 2 required checks failed; nothing was published/);
    expect(service.describe('task-1')?.verification).toMatchObject({ status: 'failed', publication: 'blocked' });
    const logs = service.logsFor('task-1');
    expect(logs.some((entry) => entry.message.includes('Check "Unit tests" failed') && (entry.details ?? '').includes('error TS2322'))).toBe(true);
  });

  it('warn: a failing check is reported and publication proceeds', async () => {
    const h = harness({ policy: 'warn', checks: CHECKS });
    h.verification.exits = { typecheck: 2 };
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.publication.prPosts).toBe(1);
    expect(h.cp.tasks.get('task-1')?.outcome).toMatch(/verification failed on [0-9a-f]{12}: 1 of 2 required checks failed \(policy: warn\)/);
    expect([...h.cp.verifications.values()][0]).toMatchObject({ status: 'failed', publication: 'allowed' });
  });

  it('no checks under warn: no verifying state, and the run reports verification as skipped', async () => {
    const h = harness(undefined);
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(states(journal, started.runId)).toEqual(['running', 'finishing', 'succeeded']);
    expect(h.verification.runs).toBe(0);
    expect(h.cp.verifications.size).toBe(0);
    expect(service.describe('task-1')?.verification).toMatchObject({ status: 'skipped', publication: 'allowed' });
  });

  it('require-pass with no checks configured blocks publication (nothing to verify is not a pass)', async () => {
    const h = harness({ policy: 'require-pass' });
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('failed');
    expect(h.publication.pushCalls).toBe(0);
    expect([...h.cp.verifications.values()][0]).toMatchObject({ status: 'skipped', publication: 'blocked' });
  });
});

describe('W11a recovery and cancellation', () => {
  it('a crash before the result was journaled re-runs the checks on restart; one commit, one evidence record, then publication', async () => {
    const h = harness({ policy: 'require-pass', checks: CHECKS });
    h.cp.addTask('task-1');
    // The checks finished but the process died before their result was journaled.
    const first = h.boot(h.crashAt('after:effect:verify.run:dispatch'));
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => {
      try {
        first.journal.get(started.runId);
        return null;
      } catch {
        return true;
      }
    }, 'crash');

    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.verification.runs).toBe(2);
    expect(h.verification.inputs[1]?.commitSha).toBe(h.verification.inputs[0]?.commitSha);
    expect(h.publication.commits).toHaveLength(1);
    expect(h.cp.verifications.size).toBe(1);
    expect(h.publication.prPosts).toBe(1);
  });

  it('a crash after the result was journaled reuses it (checks are not run again) and projects the evidence once', async () => {
    const h = harness({ policy: 'warn', checks: CHECKS });
    h.cp.addTask('task-1');
    const first = h.boot(h.crashAt('after:effect:verify.run:receipt'));
    const started = await first.service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => {
      try {
        first.journal.get(started.runId);
        return null;
      } catch {
        return true;
      }
    }, 'crash');

    const second = h.boot();
    await second.service.recover();
    await settled(second.journal, h.cp, started.runId, 'task-1');
    expect(second.journal.get(started.runId)?.state).toBe('succeeded');
    expect(h.verification.runs).toBe(1);
    expect(h.cp.verifications.size).toBe(1);
    expect(second.service.logsFor('task-1').some((entry) => entry.message.startsWith('Reusing the recorded verification'))).toBe(true);
  });

  it('cancel while verifying stops the checks, keeps the evidence and publishes nothing', async () => {
    const h = harness({ policy: 'warn', checks: CHECKS });
    h.verification.hold = true;
    h.cp.addTask('task-1');
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await waitFor(() => (h.verification.runs > 0 && journal.get(started.runId)?.state === 'verifying' ? true : null), 'verifying');
    const cancelled = await service.cancel('task-1');
    expect(cancelled.success).toBe(true);
    await settled(journal, h.cp, started.runId, 'task-1');
    expect(journal.get(started.runId)?.state).toBe('cancelled');
    expect(h.publication.pushCalls).toBe(0);
    const evidence = [...h.cp.verifications.values()];
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ status: 'error' });
    expect(service.describe('task-1')?.verification).toMatchObject({ status: 'error' });
  });
});

describe('W11a retention through the run service', () => {
  it('a follow-up on an expired workspace says so (receipt), and the run view reports it', async () => {
    const h = harness(undefined);
    h.cp.addTask('task-1');
    h.workspace.release = async (workspace) => {
      rmSync(workspace.worktreePath, { recursive: true, force: true });
    };
    const { service, journal } = h.boot();
    const started = await service.submit({ credential: fakeCredential(), taskId: 'task-1' });
    await settled(journal, h.cp, started.runId, 'task-1');
    const kept = await service.sweepRetention();
    expect(kept?.removed).toEqual([]);
    const report = await service.sweepRetention({ retainMs: 0 });
    expect(report?.removed.map((entry) => entry.reason)).toEqual(['retention_expired']);
    expect(service.describe('task-1')?.workspaceExpired).toMatchObject({ reason: 'retention_expired' });
    await expect(service.followUp({ credential: fakeCredential(), taskId: 'task-1', request: { message: 'more', comments: [] } }))
      .rejects.toMatchObject({ statusCode: 409, code: 'FOLLOW_UP_UNSUPPORTED', details: { reason: 'workspace_expired', cleanupReason: 'retention_expired' } });
  });
});
