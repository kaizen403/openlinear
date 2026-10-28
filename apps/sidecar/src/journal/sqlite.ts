import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentEvent, JournalRun, JournalRunStatus } from '@openlinear/execution-core';
import { executionSseId } from '@openlinear/execution-core';
import type { OpenLinearClient } from '@openlinear/api-client';
import { sidecarAppDataDir } from '../config/app-data';

export interface JournalAppendResult {
  seq: number;
  sseId: string;
}

export class RunJournal {
  private readonly db: DatabaseSync;
  private readonly pending = new Map<string, Array<{ seq: number; type: string; at: string; payload: unknown }>>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly api?: OpenLinearClient | null,
  ) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        batchId TEXT,
        runner TEXT NOT NULL,
        externalSessionId TEXT,
        worktreePath TEXT,
        status TEXT NOT NULL,
        startedAt INTEGER NOT NULL,
        heartbeatAt INTEGER NOT NULL,
        finishedAt INTEGER,
        budgetsJson TEXT NOT NULL,
        usageJson TEXT
      );
      CREATE TABLE IF NOT EXISTS run_events (
        runId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        type TEXT NOT NULL,
        payloadJson TEXT NOT NULL,
        PRIMARY KEY (runId, seq)
      );
    `);
  }

  static defaultPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
    return join(sidecarAppDataDir(env, platform), 'journal', 'runs.sqlite');
  }

  startRun(run: Omit<JournalRun, 'heartbeatAt' | 'finishedAt' | 'startedAt'> & { startedAt?: number }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO runs (id, taskId, batchId, runner, externalSessionId, worktreePath, status, startedAt, heartbeatAt, finishedAt, budgetsJson, usageJson)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      run.id,
      run.taskId,
      run.batchId,
      run.runner,
      run.externalSessionId,
      run.worktreePath,
      run.status,
      run.startedAt ?? now,
      now,
      run.budgetsJson,
      run.usageJson,
    );
  }

  heartbeat(runId: string): void {
    this.db.prepare('UPDATE runs SET heartbeatAt = ? WHERE id = ?').run(Date.now(), runId);
  }

  setStatus(runId: string, status: JournalRunStatus, finishedAt?: number): void {
    this.db.prepare('UPDATE runs SET status = ?, finishedAt = COALESCE(?, finishedAt) WHERE id = ?')
      .run(status, finishedAt ?? null, runId);
  }

  append(runId: string, event: AgentEvent): JournalAppendResult {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM run_events WHERE runId = ?').get(runId) as { maxSeq: number } | undefined;
    const seq = (row?.maxSeq ?? 0) + 1;
    const at = Date.now();
    this.db.prepare('INSERT INTO run_events (runId, seq, at, type, payloadJson) VALUES (?, ?, ?, ?, ?)')
      .run(runId, seq, at, event.t, JSON.stringify(event));
    this.heartbeat(runId);
    this.queueMirror(runId, seq, event.t, at, event);
    return { seq, sseId: executionSseId(runId, seq) };
  }

  listRunning(): JournalRun[] {
    const rows = this.db.prepare("SELECT * FROM runs WHERE status IN ('running', 'completing')").all() as JournalRun[];
    return rows;
  }

  getRun(runId: string): JournalRun | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as JournalRun | undefined;
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.db.close();
  }

  private queueMirror(runId: string, seq: number, type: string, at: number, payload: unknown): void {
    if (!this.api) return;
    const list = this.pending.get(runId) ?? [];
    list.push({ seq, type, at: new Date(at).toISOString(), payload });
    this.pending.set(runId, list);
    if (list.length >= 50) {
      void this.flush(runId);
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flushAll();
      }, 500);
    }
  }

  private async flushAll(): Promise<void> {
    for (const runId of [...this.pending.keys()]) {
      await this.flush(runId);
    }
  }

  private async flush(runId: string): Promise<void> {
    const events = this.pending.get(runId);
    if (!events || events.length === 0 || !this.api) return;
    this.pending.delete(runId);
    try {
      await this.api.progress({ runId, events });
    } catch {
      const existing = this.pending.get(runId) ?? [];
      this.pending.set(runId, [...events, ...existing]);
    }
  }
}
