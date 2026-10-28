import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableRunJournal } from '../journal/durable';
import { createSandboxedCheckExecutor } from '../run/verification/executor';
import type { RunSnapshot } from '../run/types';
import { launchRunnerProcess, type RunnerProcessSpec } from '../runners/shared/sandboxed-process';
import { grantCovers, resolveSandboxMode } from './mode';
import { getLastCapabilityReport, getVerifiedProvider, setProviderFactoryForTests } from './provider';
import { createJournalRunScope, realpathOfNearest, runRootsFor } from './trust-grant-scope';
import { configureTrustGrants, TrustGrantStore, type TrustGrant } from './trust-grants';
import type { CapabilityReport, SandboxProvider } from './types';

/**
 * FE-03 acceptance: an unavailable sandbox blocks execution; host access
 * needs an explicit, scoped, expiring trust grant. Stored grants apply only
 * while no verified sandbox is available, only to their project's runs by
 * their creator, never once expired or revoked; a working sandbox ignores
 * them; the environment grant keeps working unchanged.
 */

const HOUR = 3_600_000;
let root = '';
let repos = '';
let journal: DurableRunJournal;
let store: TrustGrantStore;
let roots: { agent: string; verification: string };

function snapshot(projectId: string | null): RunSnapshot {
  return {
    title: 'T', description: null, model: null, agent: null, labels: [], projectId, teamId: 'team-1', creatorId: 'user-1', localPath: null,
    repository: { id: 'repo-1', name: 'repo', fullName: 'acme/repo', cloneUrl: 'https://github.com/acme/repo.git', defaultBranch: 'main' },
  };
}

function journalRun(runId: string, userId: string, projectId: string | null, worktreePath?: string): void {
  journal.createRun({ runId, taskId: `task-${runId}`, userId, attemptId: null, capability: null, capabilityExpiresAt: null, runner: 'codex', model: null, state: 'preparing', snapshot: snapshot(projectId), bootId: 'boot' }, {});
  if (worktreePath) {
    journal.update(runId, { workspace: { worktreePath, branch: `openlinear/${runId}`, baseRef: 'main', owned: true, handle: null } });
  }
}

function report(available: boolean, checkedAt = new Date().toISOString()): CapabilityReport {
  return {
    provider: 'macos-seatbelt', providerVersion: 'fake', platform: process.platform, available, checkedAt, durationMs: 1,
    enforced: { filesystem: available, env: available, network: available, process: available },
    probes: [], blockers: available ? [] : ['sandbox-exec is missing'], warnings: [], unsupported: [],
  };
}

function provider(available: boolean, counter = { preflights: 0 }): SandboxProvider {
  return {
    id: 'macos-seatbelt',
    proxyTransport: 'tcp',
    unsupportedLimits: [],
    detect: async () => ({ ok: true, version: 'fake', blockers: [], warnings: [] }),
    preflight: async () => {
      counter.preflights += 1;
      return report(available);
    },
    wrap: async () => {
      throw new Error('not used: the sandbox is unavailable in these tests');
    },
  };
}

async function sandbox(available: boolean): Promise<void> {
  setProviderFactoryForTests(() => provider(available));
  await getVerifiedProvider().catch(() => undefined);
  expect(getLastCapabilityReport()?.available).toBe(available);
}

function grant(extra: { userId?: string; projectId?: string; hours?: number } = {}, now = Date.now()): TrustGrant {
  return store.create({
    userId: extra.userId ?? 'user-1',
    projectId: extra.projectId ?? 'proj-1',
    projectName: 'Alpha',
    reason: 'Sandbox unavailable on this laptop; trusted repo',
    hours: extra.hours ?? 24,
    paths: [roots.agent, roots.verification],
  }, now);
}

function dir(...parts: string[]): string {
  const path = join(repos, ...parts);
  mkdirSync(path, { recursive: true });
  return realpathSync.native(path);
}

function used(): Array<{ grantId: string; runId: string | null; kind: string | null }> {
  return store.audit().filter((entry) => entry.event === 'used').map(({ grantId, runId, kind }) => ({ grantId, runId, kind }));
}

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'openlinear-trust-mode-')));
  repos = join(root, 'repos');
  dir('worktrees', 'run-a');
  dir('verify', 'run-a');
  dir('worktrees', 'run-b');
  dir('worktrees', 'run-c');
  dir('worktrees', 'run-legacy');
  dir('worktrees', 'run-noproject');
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  roots = runRootsFor(repos);
  journal = new DurableRunJournal(join(root, 'journal', 'runs-v2.sqlite'));
  journalRun('run-a', 'user-1', 'proj-1', join(repos, 'worktrees', 'run-a'));
  journalRun('run-b', 'user-1', 'proj-2', join(repos, 'worktrees', 'run-b'));
  journalRun('run-c', 'user-2', 'proj-1', join(repos, 'worktrees', 'run-c'));
  journalRun('run-noproject', 'user-1', null, join(repos, 'worktrees', 'run-noproject'));
});

afterAll(() => {
  journal.close();
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  store = new TrustGrantStore(join(root, `grants-${Math.random().toString(16).slice(2)}`));
  configureTrustGrants({ store, scope: createJournalRunScope({ journalPath: () => journal.path, reposRoot: () => repos }), runRoots: () => [roots.agent, roots.verification] });
});

afterEach(() => {
  configureTrustGrants(null);
  setProviderFactoryForTests(null);
  vi.useRealTimers();
});

describe('stored trust grants in sandbox mode resolution', () => {
  it('a verified sandbox ignores stored grants entirely', async () => {
    await sandbox(true);
    grant();
    expect(resolveSandboxMode({})).toEqual({ mode: 'enforce' });
    expect(used()).toEqual([]);
  });

  it('no preflight result yet counts as enforce (never as unavailable)', () => {
    grant();
    expect(getLastCapabilityReport()).toBeNull();
    expect(resolveSandboxMode({})).toEqual({ mode: 'enforce' });
  });

  it('an unavailable sandbox without a grant stays enforce (runs are refused)', async () => {
    await sandbox(false);
    expect(resolveSandboxMode({})).toEqual({ mode: 'enforce' });
  });

  it('an unavailable sandbox with an active grant runs that project\'s checkouts on the host — audited, and named in the decision', async () => {
    await sandbox(false);
    const g = grant();
    const decision = resolveSandboxMode({});
    expect(decision).toMatchObject({ mode: 'trusted-host', grant: { source: 'store', grantId: g.id } });
    if (decision.mode !== 'trusted-host') return;
    expect(grantCovers(decision.grant, join(repos, 'worktrees', 'run-a'))).toBe(true);
    expect(decision.grant).toMatchObject({ grantId: g.id, actor: 'user-1', reason: g.reason, expiresAt: g.expiresAt, paths: g.paths });
    const verify = resolveSandboxMode({});
    expect(verify.mode === 'trusted-host' && grantCovers(verify.grant, join(repos, 'verify', 'run-a'))).toBe(true);
    expect(used()).toEqual([{ grantId: g.id, runId: 'run-a', kind: 'verification' }, { grantId: g.id, runId: 'run-a', kind: 'agent' }]);
    expect(store.active(Date.now())[0]?.useCount).toBe(2);
  });

  it('covers only its project, its creator\'s runs and the engine\'s checkout roots', async () => {
    await sandbox(false);
    grant();
    grant({ userId: 'user-3', projectId: 'proj-2' });
    const covers = (path: string) => {
      const decision = resolveSandboxMode({});
      return decision.mode === 'trusted-host' && grantCovers(decision.grant, path);
    };
    expect(covers(join(repos, 'worktrees', 'run-b'))).toBe(false); // proj-2, but run by user-1 (grant is user-3's)
    expect(covers(join(repos, 'worktrees', 'run-c'))).toBe(false); // proj-1, but run by user-2
    expect(covers(join(repos, 'worktrees', 'run-legacy'))).toBe(false); // not journaled (legacy engine)
    expect(covers(join(repos, 'worktrees', 'run-noproject'))).toBe(false); // no project
    expect(covers(join(root, 'elsewhere'))).toBe(false); // outside the run roots
    expect(covers(repos)).toBe(false);
    expect(used()).toEqual([]);
  });

  it('a follow-up that adopted a worktree is attributed to the newest run using it', async () => {
    await sandbox(false);
    const g = grant();
    dir('worktrees', 'run-f');
    journalRun('run-f', 'user-2', 'proj-1', join(repos, 'worktrees', 'run-f'));
    const before = resolveSandboxMode({});
    expect(before.mode === 'trusted-host' && grantCovers(before.grant, join(repos, 'worktrees', 'run-f'))).toBe(false);
    journalRun('run-f-followup', 'user-1', 'proj-1', join(repos, 'worktrees', 'run-f'));
    const decision = resolveSandboxMode({});
    expect(decision.mode === 'trusted-host' && grantCovers(decision.grant, join(repos, 'worktrees', 'run-f'))).toBe(true);
    expect(used()).toEqual([{ grantId: g.id, runId: 'run-f-followup', kind: 'agent' }]);
  });

  it('expired and revoked grants never apply, including to a decision taken before the revoke', async () => {
    await sandbox(false);
    const now = Date.now();
    const short = grant({ hours: 1 }, now);
    expect(resolveSandboxMode({}, now + HOUR - 1).mode).toBe('trusted-host');
    expect(resolveSandboxMode({}, now + HOUR)).toEqual({ mode: 'enforce' });
    store.revoke(short.id, 'user-1', now);
    const live = grant({}, now);
    const before = resolveSandboxMode({});
    store.revoke(live.id, 'user-1', Date.now());
    expect(before.mode === 'trusted-host' && grantCovers(before.grant, join(repos, 'worktrees', 'run-a'))).toBe(false);
    expect(resolveSandboxMode({})).toEqual({ mode: 'enforce' });
    expect(used()).toEqual([]);
  });

  it('a use that cannot be audited is refused', async () => {
    await sandbox(false);
    grant();
    vi.spyOn(store, 'recordUse').mockImplementation(() => {
      throw new Error('disk full');
    });
    const decision = resolveSandboxMode({});
    expect(decision.mode === 'trusted-host' && grantCovers(decision.grant, join(repos, 'worktrees', 'run-a'))).toBe(false);
  });

  it('is inert when turned off on the device or when no grant store is configured', async () => {
    await sandbox(false);
    grant();
    expect(resolveSandboxMode({ OPENLINEAR_SANDBOX_USER_GRANTS: '0' })).toEqual({ mode: 'enforce' });
    configureTrustGrants(null);
    expect(resolveSandboxMode({})).toEqual({ mode: 'enforce' });
  });

  it('leaves the environment grant unchanged: it takes precedence and is never audited as a stored grant', async () => {
    await sandbox(false);
    grant();
    const envGrant = JSON.stringify({ actor: 'ops@example.com', reason: 'host mode for this CI box', expiresAt: new Date(Date.now() + HOUR).toISOString(), paths: [join(root, 'elsewhere')] });
    const decision = resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'trusted-host', OPENLINEAR_SANDBOX_TRUSTED_HOST_GRANT: envGrant });
    expect(decision).toMatchObject({ mode: 'trusted-host', grant: { source: 'env', actor: 'ops@example.com' } });
    if (decision.mode !== 'trusted-host') return;
    expect(grantCovers(decision.grant, join(root, 'elsewhere', 'x'))).toBe(true);
    expect(grantCovers(decision.grant, join(repos, 'worktrees', 'run-a'))).toBe(false);
    expect(() => resolveSandboxMode({ OPENLINEAR_SANDBOX_MODE: 'off' })).toThrow(/Unknown OPENLINEAR_SANDBOX_MODE/);
    expect(used()).toEqual([]);
  });

  it('re-checks a stale failed preflight in the background; once the sandbox works, grants stop applying', async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'], now: start });
    const state = { available: false, preflights: 0 };
    setProviderFactoryForTests(() => ({ ...provider(state.available), preflight: async () => {
      state.preflights += 1;
      return report(state.available);
    } }));
    await getVerifiedProvider().catch(() => undefined);
    grant({}, start);
    expect(resolveSandboxMode({}, start + 1_000).mode).toBe('trusted-host');
    expect(state.preflights).toBe(1);
    // The sandbox gets fixed; the cached failure is still the last word until it is re-checked.
    state.available = true;
    vi.setSystemTime(start + 31_000);
    expect(resolveSandboxMode({}, start + 31_000).mode).toBe('trusted-host');
    await vi.waitFor(() => expect(getLastCapabilityReport()?.available).toBe(true));
    expect(state.preflights).toBe(2);
    expect(resolveSandboxMode({}, start + 32_000)).toEqual({ mode: 'enforce' });
  });
});

describe('callers reach stored grants through the unchanged signatures', () => {
  const env = () => ({ PATH: '/usr/bin:/bin', HOME: join(root, 'home'), OPENLINEAR_SANDBOX_DIR: join(root, 'sandbox') });
  const spec = (worktree: string): RunnerProcessSpec => ({
    runner: 'codex',
    worktree,
    binary: '/bin/echo',
    argv: (mode) => [mode],
    enforceEnv: () => ({}),
    hostEnv: () => ({ PATH: '/usr/bin:/bin' }),
    egressProviders: [],
  });

  it('runner launch: refused without a grant, on the host under the project grant (metadata names it)', async () => {
    await sandbox(false);
    await expect(launchRunnerProcess(spec(join(repos, 'worktrees', 'run-a')), { env: env() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    const g = grant();
    await expect(launchRunnerProcess(spec(join(repos, 'worktrees', 'run-b')), { env: env() })).rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
    const proc = await launchRunnerProcess(spec(join(repos, 'worktrees', 'run-a')), { env: env() });
    expect(await proc.exited).toEqual({ code: 0, signal: null });
    await proc.dispose();
    expect(proc.metadata).toMatchObject({ mode: 'trusted-host', grant: { grantId: g.id, source: 'store', actor: 'user-1' } });
    expect(used()).toEqual([{ grantId: g.id, runId: 'run-a', kind: 'agent' }]);
  });

  it('verification checks: not run without a covering grant, run on the host under it', async () => {
    await sandbox(false);
    const executor = createSandboxedCheckExecutor({ env: env(), killGraceMs: 100 });
    const run = (checkout: string, name: string) => executor.run({
      check: { id: name, name, argv: ['/bin/sh', '-c', 'echo checked'], cwd: '', timeoutMs: 10_000, network: { mode: 'none' }, required: true },
      checkoutPath: checkout,
      privateRoot: join(root, 'private', name),
      readRoots: [],
      denyRoots: [],
      logPath: join(root, `${name}.log`),
      signal: new AbortController().signal,
    });
    const refused = await run(dir('verify', 'run-a'), 'no-grant');
    expect(refused).toMatchObject({ status: 'error', sandbox: { mode: 'none' } });
    const g = grant();
    const otherProject = await run(dir('verify', 'run-b'), 'other-project');
    expect(otherProject.status).toBe('error');
    const passed = await run(dir('verify', 'run-a'), 'granted');
    expect(passed).toMatchObject({ status: 'passed', exitCode: 0, sandbox: { mode: 'trusted-host' } });
    expect(readFileSync(join(root, 'granted.log'), 'utf8')).toContain('checked');
    expect(used()).toEqual([{ grantId: g.id, runId: 'run-a', kind: 'verification' }]);
  });
});

describe('grant roots', () => {
  it('resolve to realpaths even before the first run created them', () => {
    const fresh = join(root, 'link-target');
    mkdirSync(fresh, { recursive: true });
    const link = join(root, 'link');
    symlinkSync(fresh, link);
    expect(realpathOfNearest(join(link, 'repos', 'worktrees'))).toBe(join(fresh, 'repos', 'worktrees'));
    expect(runRootsFor(join(link, 'repos'))).toEqual({ agent: join(fresh, 'repos', 'worktrees'), verification: join(fresh, 'repos', 'verify') });
    expect(realpathOfNearest('/')).toBe(realpathSync.native('/'));
  });
});
