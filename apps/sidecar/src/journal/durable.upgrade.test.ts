import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeSnapshot } from '../run/test-support';
import { DURABLE_JOURNAL_SCHEMA_VERSION, DurableRunJournal } from './durable';

/**
 * W11a journal schema 2: a version-1 file (CHECK lists without `verifying`
 * and the verification effects, no `verification_json`) is upgraded in place
 * on open — rows copied unchanged, indexes and the immutability trigger
 * recreated — and accepts the new state and effect kinds afterwards.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tableSql(db: DatabaseSync, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
  return row?.sql ?? '';
}

/** Rewrite the three contract tables to their version-1 shape, keeping every row. */
function downgradeToV1(path: string): void {
  const db = new DatabaseSync(path);
  const v1: Record<string, (sql: string) => string> = {
    run_attempts: (sql) => sql.replace("'verifying', ", '').replace(/\s*verification_json TEXT,/, ''),
    run_effects: (sql) => sql.replace(", 'verify.run', 'verification.record'", ''),
  };
  db.exec('BEGIN IMMEDIATE');
  for (const [table, rewrite] of Object.entries(v1)) {
    const current = tableSql(db, table);
    const old = rewrite(current).replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}__v1`).replace(`CREATE TABLE "${table}"`, `CREATE TABLE ${table}__v1`);
    expect(old).not.toBe(current);
    db.exec(old);
    const columns = (db.prepare(`PRAGMA table_info(${table}__v1)`).all() as Array<{ name: string }>).map((column) => column.name).join(', ');
    db.exec(`INSERT INTO ${table}__v1 (${columns}) SELECT ${columns} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__v1 RENAME TO ${table}`);
  }
  db.exec('DROP TABLE IF EXISTS workspace_cleanups');
  db.exec('DROP TABLE IF EXISTS task_hints');
  db.prepare("UPDATE journal_meta SET value = '1' WHERE key = 'schema_version'").run();
  db.exec('COMMIT');
  db.close();
}

describe('W11a durable journal upgrade (schema 1 → 2)', () => {
  it('upgrades a version-1 file in place without losing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'ol-journal-upgrade-'));
    roots.push(root);
    const path = join(root, 'runs-v2.sqlite');

    const original = new DurableRunJournal(path);
    original.createRun({
      runId: 'run-1', taskId: 'task-1', userId: 'user-1', attemptId: 'attempt-1', capability: null, capabilityExpiresAt: null,
      runner: 'opencode', model: 'stub/model', state: 'preparing', snapshot: fakeSnapshot('task-1'), bootId: 'boot-1',
    }, { reason: 'test' });
    original.recordEffect('run-1', { key: 'run-1:attempt.claim', kind: 'attempt.claim', intent: {} });
    const eventsBefore = original.events('run-1', 0, 100).length;
    original.close();

    downgradeToV1(path);
    const legacy = new DatabaseSync(path);
    expect(tableSql(legacy, 'run_attempts')).not.toContain("'verifying'");
    expect(tableSql(legacy, 'run_attempts')).not.toContain('verification_json');
    legacy.close();

    const upgraded = new DurableRunJournal(path);
    const record = upgraded.get('run-1');
    expect(record).toMatchObject({ runId: 'run-1', taskId: 'task-1', state: 'preparing', verification: null, model: 'stub/model' });
    expect(record?.snapshot.title).toBe(fakeSnapshot('task-1').title);
    expect(upgraded.events('run-1', 0, 100)).toHaveLength(eventsBefore);
    expect(upgraded.effects('run-1').map((effect) => effect.kind)).toEqual(['attempt.claim']);

    // The new contract is accepted: verification manifest column, verification effects, retention tables.
    upgraded.recordEffect('run-1', { key: 'run-1:verify.run:abc', kind: 'verify.run', intent: { sha: 'abc' } });
    upgraded.recordWorkspaceCleanup({ worktreePath: '/tmp/x', runId: 'run-1', taskId: 'task-1', branch: null, reason: 'retention_expired', bytes: null });
    upgraded.close();

    const check = new DatabaseSync(path);
    expect(tableSql(check, 'run_attempts')).toContain("'verifying'");
    expect(tableSql(check, 'run_attempts')).toContain('verification_json');
    expect(tableSql(check, 'run_effects')).toContain("'verification.record'");
    const meta = check.prepare("SELECT value FROM journal_meta WHERE key = 'schema_version'").get() as { value: string };
    expect(meta.value).toBe(String(DURABLE_JOURNAL_SCHEMA_VERSION));
    // Events stay immutable after the rebuild (trigger recreated).
    expect(() => check.exec("UPDATE run_attempt_events SET at = 0 WHERE run_id = 'run-1'")).toThrow(/immutable/);
    const leftovers = check.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%__upgrade' OR name LIKE '%__v1'").all();
    expect(leftovers).toEqual([]);
    check.close();
  });

  it('opening a current file again is a no-op (no rebuild)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ol-journal-upgrade-'));
    roots.push(root);
    const path = join(root, 'runs-v2.sqlite');
    new DurableRunJournal(path).close();
    const before = new DatabaseSync(path);
    const sql = tableSql(before, 'run_attempts');
    before.close();
    new DurableRunJournal(path).close();
    const after = new DatabaseSync(path);
    expect(tableSql(after, 'run_attempts')).toBe(sql);
    after.close();
  });
});
