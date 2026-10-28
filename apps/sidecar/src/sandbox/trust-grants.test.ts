import { appendFileSync, chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRUST_GRANT_MAX_ACTIVE_PER_USER, TRUST_GRANT_MAX_HOURS, TrustGrantStore, userTrustGrantsEnabled, type CreateTrustGrantInput } from './trust-grants';

/** FE-03: the device-local grants store — expiry, revoke, audit, file permissions. */

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-27T10:00:00.000Z');
const posix = process.platform !== 'win32';

let root = '';
let store: TrustGrantStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openlinear-trust-grants-'));
  store = new TrustGrantStore(join(root, 'trust-grants'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function input(extra: Partial<CreateTrustGrantInput> = {}): CreateTrustGrantInput {
  return {
    userId: 'user-1',
    projectId: 'proj-1',
    projectName: 'Alpha',
    reason: 'Seatbelt broke after the OS update; reviewed repo only',
    hours: 24,
    paths: ['/repos/worktrees', '/repos/verify'],
    ...extra,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? 'no code';
  }
  return 'did not throw';
}

describe('trust grant store', () => {
  it('creates a scoped, expiring grant in owner-only files and audits it', () => {
    const grant = store.create(input(), T0);
    expect(grant).toMatchObject({
      id: expect.stringMatching(/^tg_[0-9a-f]{16}$/),
      projectId: 'proj-1',
      projectName: 'Alpha',
      paths: ['/repos/verify', '/repos/worktrees'],
      createdBy: 'user-1',
      createdAt: '2026-10-27T10:00:00.000Z',
      expiresAt: '2026-10-28T10:00:00.000Z',
      revokedAt: null,
      useCount: 0,
    });
    if (posix) {
      expect(statSync(store.dir).mode & 0o777).toBe(0o700);
      expect(statSync(store.grantsFile).mode & 0o777).toBe(0o600);
      expect(statSync(store.auditFile).mode & 0o777).toBe(0o600);
    }
    expect(store.audit()).toEqual([expect.objectContaining({ event: 'created', grantId: grant.id, owner: 'user-1', actor: 'user-1', projectName: 'Alpha' })]);
    // Persisted: a new process sees the same grant.
    expect(new TrustGrantStore(store.dir).active(T0 + HOUR).map((g) => g.id)).toEqual([grant.id]);
  });

  it('validates reason, duration (at most 7 days), project and paths; one active grant per project and user', () => {
    expect(codeOf(() => store.create(input({ reason: '  short  ' }), T0))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => store.create(input({ hours: 0 }), T0))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => store.create(input({ hours: TRUST_GRANT_MAX_HOURS + 1 }), T0))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => store.create(input({ hours: 1.5 }), T0))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => store.create(input({ projectId: '../etc' }), T0))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => store.create(input({ paths: ['relative/path'] }), T0))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => store.create(input({ paths: [] }), T0))).toBe('VALIDATION_ERROR');
    expect(store.create(input({ hours: TRUST_GRANT_MAX_HOURS }), T0).expiresAt).toBe('2026-11-03T10:00:00.000Z');
    expect(codeOf(() => store.create(input(), T0))).toBe('TRUST_GRANT_EXISTS');
    // Another user may grant the same project for their own runs.
    expect(store.create(input({ userId: 'user-2' }), T0).createdBy).toBe('user-2');
    expect(store.audit().filter((entry) => entry.event === 'created')).toHaveLength(2);
  });

  it('caps the number of active grants per user', () => {
    for (let index = 0; index < TRUST_GRANT_MAX_ACTIVE_PER_USER; index += 1) store.create(input({ projectId: `proj-${index}` }), T0);
    expect(codeOf(() => store.create(input({ projectId: 'proj-extra' }), T0))).toBe('TRUST_GRANT_LIMIT');
  });

  it('strips control characters from the reason and project name', () => {
    const grant = store.create(input({ reason: 'line one\nline two\u0007 is fine', projectName: 'A\u0000B' }), T0);
    expect(grant.reason).toBe('line one line two  is fine');
    expect(grant.projectName).toBe('A B');
  });

  it('expires: a grant stops applying at expiresAt and the expiry is audited once', () => {
    const grant = store.create(input({ hours: 1 }), T0);
    expect(store.active(T0 + HOUR - 1).map((g) => g.id)).toEqual([grant.id]);
    expect(store.active(T0 + HOUR)).toEqual([]);
    expect(store.active(T0 + 2 * HOUR)).toEqual([]);
    expect(store.audit().map((entry) => entry.event)).toEqual(['expired', 'created']);
    expect(store.audit()[0]).toMatchObject({ grantId: grant.id, actor: null, owner: 'user-1' });
    // An expired grant can be replaced by a new one for the same project.
    expect(store.create(input(), T0 + 2 * HOUR).id).not.toBe(grant.id);
  });

  it('revokes only the owner\'s grant, idempotently; a revoked grant never applies again', () => {
    const grant = store.create(input(), T0);
    expect(codeOf(() => store.revoke(grant.id, 'user-2', T0 + 1))).toBe('TRUST_GRANT_NOT_FOUND');
    expect(codeOf(() => store.revoke('tg_0000000000000000', 'user-1', T0 + 1))).toBe('TRUST_GRANT_NOT_FOUND');
    const revoked = store.revoke(grant.id, 'user-1', T0 + 1_000);
    expect(revoked).toMatchObject({ revokedAt: '2026-10-27T10:00:01.000Z', revokedBy: 'user-1' });
    expect(store.revoke(grant.id, 'user-1', T0 + 2_000).revokedAt).toBe('2026-10-27T10:00:01.000Z');
    expect(store.active(T0 + 2_000)).toEqual([]);
    expect(store.activeFor('user-1', T0 + 2_000)).toEqual([]);
    expect(store.audit().map((entry) => entry.event)).toEqual(['revoked', 'created']);
    expect(codeOf(() => store.recordUse(grant.id, { runId: 'run-1', kind: 'agent', path: '/repos/worktrees/run-1', userId: 'user-1' }, T0 + 3_000))).toBe('TRUST_GRANT_NOT_FOUND');
  });

  it('tells listeners which runs used a grant when it is revoked or runs out (once each), so they can be stopped', () => {
    const ended: Array<{ grantId: string; runIds: string[] }> = [];
    store.onGrantEnded((grant, runIds) => ended.push({ grantId: grant.id, runIds: [...runIds].sort() }));
    const revokedGrant = store.create(input(), T0);
    store.recordUse(revokedGrant.id, { runId: 'run-1', kind: 'agent', path: '/repos/worktrees/run-1', userId: 'user-1' }, T0 + 1_000);
    store.recordUse(revokedGrant.id, { runId: 'run-1', kind: 'verification', path: '/repos/verify/run-1', userId: 'user-1' }, T0 + 2_000);
    store.recordUse(revokedGrant.id, { runId: 'run-2', kind: 'agent', path: '/repos/worktrees/run-2', userId: 'user-1' }, T0 + 3_000);
    store.revoke(revokedGrant.id, 'user-1', T0 + 4_000);
    store.revoke(revokedGrant.id, 'user-1', T0 + 5_000);
    expect(ended).toEqual([{ grantId: revokedGrant.id, runIds: ['run-1', 'run-2'] }]);

    const expiring = store.create(input({ projectId: 'proj-2', hours: 1 }), T0);
    store.recordUse(expiring.id, { runId: 'run-3', kind: 'agent', path: '/repos/worktrees/run-3', userId: 'user-1' }, T0 + HOUR - 1);
    store.list(T0 + HOUR - 1);
    expect(ended).toHaveLength(1);
    store.list(T0 + HOUR);
    store.list(T0 + 2 * HOUR);
    expect(ended).toEqual([{ grantId: revokedGrant.id, runIds: ['run-1', 'run-2'] }, { grantId: expiring.id, runIds: ['run-3'] }]);
  });

  it('re-checks the creation rules on read: a stretched, future-dated or reason-less grant written to the file never applies', () => {
    const kept = store.create(input(), T0);
    const stretched = store.create(input({ projectId: 'proj-2' }), T0);
    const future = store.create(input({ projectId: 'proj-3' }), T0);
    const terse = store.create(input({ projectId: 'proj-4' }), T0);
    const file = JSON.parse(readFileSync(store.grantsFile, 'utf8')) as { version: 1; grants: Array<Record<string, unknown>> };
    for (const grant of file.grants) {
      if (grant.id === stretched.id) grant.expiresAt = new Date(T0 + (TRUST_GRANT_MAX_HOURS + 1) * HOUR).toISOString();
      if (grant.id === future.id) {
        grant.createdAt = new Date(T0 + 10 * HOUR).toISOString();
        grant.expiresAt = new Date(T0 + 20 * HOUR).toISOString();
      }
      if (grant.id === terse.id) grant.reason = 'ok';
    }
    writeFileSync(store.grantsFile, JSON.stringify(file), { mode: 0o600 });
    expect(store.active(T0 + HOUR).map((grant) => grant.id)).toEqual([kept.id]);
    expect(codeOf(() => store.recordUse(stretched.id, { runId: 'run-1', kind: 'agent', path: '/repos/worktrees/run-1', userId: 'user-1' }, T0 + HOUR))).toBe('TRUST_GRANT_NOT_FOUND');
  });

  it('applies at most the newest grants per user even if the file holds more', () => {
    const grants = Array.from({ length: TRUST_GRANT_MAX_ACTIVE_PER_USER }, (_, index) => store.create(input({ projectId: `proj-${index}` }), T0 + index));
    const file = JSON.parse(readFileSync(store.grantsFile, 'utf8')) as { version: 1; grants: Array<Record<string, unknown>> };
    const extra = { ...file.grants[0], id: 'tg_ffffffffffffffff', projectId: 'proj-extra', createdAt: new Date(T0 + 100).toISOString() };
    file.grants.push(extra);
    writeFileSync(store.grantsFile, JSON.stringify(file), { mode: 0o600 });
    const active = store.active(T0 + HOUR).map((grant) => grant.id);
    expect(active).toHaveLength(TRUST_GRANT_MAX_ACTIVE_PER_USER);
    expect(active).toContain('tg_ffffffffffffffff');
    expect(active).not.toContain(grants[0]?.id);
  });

  it('records each use in the audit with the run, the checkout and who ran it', () => {
    const grant = store.create(input(), T0);
    const used = store.recordUse(grant.id, { runId: 'run-1', kind: 'agent', path: '/repos/worktrees/run-1', userId: 'user-1' }, T0 + HOUR);
    expect(used).toMatchObject({ useCount: 1, lastUsedAt: '2026-10-27T11:00:00.000Z' });
    store.recordUse(grant.id, { runId: 'run-1', kind: 'verification', path: '/repos/verify/run-1', userId: 'user-1' }, T0 + 2 * HOUR);
    expect(store.active(T0 + 2 * HOUR)[0]?.useCount).toBe(2);
    expect(store.audit({ limit: 2 })).toEqual([
      expect.objectContaining({ event: 'used', runId: 'run-1', kind: 'verification', path: '/repos/verify/run-1', actor: 'user-1' }),
      expect.objectContaining({ event: 'used', runId: 'run-1', kind: 'agent', path: '/repos/worktrees/run-1' }),
    ]);
  });

  it('counts repeated decisions for the same run and kind as one use (within minutes)', () => {
    const grant = store.create(input(), T0);
    const use = { runId: 'run-1', kind: 'agent' as const, path: '/repos/worktrees/run-1', userId: 'user-1' };
    store.recordUse(grant.id, use, T0 + 1_000);
    store.recordUse(grant.id, use, T0 + 2_000);
    store.recordUse(grant.id, { ...use, runId: 'run-2' }, T0 + 3_000);
    expect(store.audit().filter((entry) => entry.event === 'used').map((entry) => entry.runId)).toEqual(['run-2', 'run-1']);
    store.recordUse(grant.id, use, T0 + 11 * 60_000);
    expect(store.active(T0 + 11 * 60_000)[0]?.useCount).toBe(3);
  });

  it('keeps the audit append-only, filtered per owner, newest first, skipping torn lines', () => {
    const a = store.create(input(), T0);
    store.create(input({ userId: 'user-2', projectId: 'proj-2' }), T0 + 1);
    appendFileSync(store.auditFile, '{"torn": ');
    appendFileSync(store.auditFile, '\n');
    store.revoke(a.id, 'user-1', T0 + 2);
    const lines = readFileSync(store.auditFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(store.audit({ owner: 'user-1' }).map((entry) => entry.event)).toEqual(['revoked', 'created']);
    expect(store.audit({ owner: 'user-2' }).map((entry) => entry.projectId)).toEqual(['proj-2']);
  });

  it('ignores a grants file other users can read or write, and sets it aside on the next write', () => {
    if (!posix) return;
    const first = store.create(input(), T0);
    chmodSync(store.grantsFile, 0o666);
    expect(store.active(T0)).toEqual([]);
    expect(store.problem).toMatch(/accessible to other users/);
    const second = store.create(input({ projectId: 'proj-2' }), T0);
    expect(store.problem).toBeNull();
    expect(store.active(T0).map((grant) => grant.id)).toEqual([second.id]);
    expect(statSync(store.grantsFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(store.dir).some((name) => name.startsWith('grants.json.rejected-'))).toBe(true);
    expect(store.active(T0).some((grant) => grant.id === first.id)).toBe(false);
  });

  it('ignores a corrupt or malformed grants file (no grant applies)', () => {
    store.create(input(), T0);
    writeFileSync(store.grantsFile, 'not json', { mode: 0o600 });
    expect(store.active(T0)).toEqual([]);
    expect(store.problem).toMatch(/not valid JSON/);
    writeFileSync(store.grantsFile, JSON.stringify({ version: 1, grants: [{ id: 'nope' }] }), { mode: 0o600 });
    expect(store.active(T0)).toEqual([]);
    expect(store.problem).toMatch(/malformed/);
  });

  it('drops grants that ended more than 30 days ago from the file (the audit keeps them)', () => {
    const old = store.create(input({ hours: 1 }), T0);
    store.create(input({ projectId: 'proj-2', hours: 1 }), T0 + 31 * 24 * HOUR);
    const kept = JSON.parse(readFileSync(store.grantsFile, 'utf8')) as { grants: Array<{ id: string }> };
    expect(kept.grants.map((grant) => grant.id)).not.toContain(old.id);
    expect(store.audit().some((entry) => entry.grantId === old.id && entry.event === 'created')).toBe(true);
  });

  it('can be turned off on a device with OPENLINEAR_SANDBOX_USER_GRANTS=0', () => {
    expect(userTrustGrantsEnabled({})).toBe(true);
    expect(userTrustGrantsEnabled({ OPENLINEAR_SANDBOX_USER_GRANTS: '1' })).toBe(true);
    expect(userTrustGrantsEnabled({ OPENLINEAR_SANDBOX_USER_GRANTS: ' 0 ' })).toBe(false);
  });
});
