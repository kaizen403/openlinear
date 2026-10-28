import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (jobs: unknown[]) => Promise<void>;

const boss = vi.hoisted(() => ({
  calls: [] as string[],
  handlers: new Map<string, (jobs: unknown[]) => Promise<void>>(),
  listeners: [] as string[],
  constructed: [] as unknown[],
  failScheduleOn: null as string | null,
  stopOptions: [] as unknown[],
}));

vi.mock('pg-boss', () => {
  class FakePgBoss {
    constructor(options: unknown) {
      boss.constructed.push(options);
    }
    on(event: string): this {
      boss.listeners.push(event);
      return this;
    }
    async start(): Promise<this> {
      boss.calls.push('start');
      return this;
    }
    async createQueue(name: string): Promise<void> {
      boss.calls.push(`createQueue:${name}`);
    }
    async work(name: string, handler: Handler): Promise<string> {
      boss.calls.push(`work:${name}`);
      boss.handlers.set(name, handler);
      return `worker-${name}`;
    }
    async schedule(name: string, cron: string): Promise<void> {
      if (name === boss.failScheduleOn) throw new Error(`Queue ${name} not found`);
      boss.calls.push(`schedule:${name}:${cron}`);
    }
    async stop(options?: unknown): Promise<void> {
      boss.stopOptions.push(options ?? null);
    }
  }
  return { default: FakePgBoss };
});

const db = vi.hoisted(() => {
  const count = (_args?: unknown) => Promise.resolve({ count: 0 });
  return {
    session: { updateMany: vi.fn(count) },
    invitation: { updateMany: vi.fn(count) },
    domainEvent: {
      deleteMany: vi.fn(count),
      // W04b retention (events/stream.ts pruneStream): an empty batch ends the loop.
      findMany: vi.fn((_args?: unknown) => Promise.resolve([] as Array<{ id: bigint }>)),
    },
    idempotencyKey: { deleteMany: vi.fn(count) },
    auditLog: { deleteMany: vi.fn(count) },
    chatAttachment: { updateMany: vi.fn(count) },
    // pruneStream runs each batch in a transaction against the same client.
    $transaction: vi.fn(<T>(fn: (tx: unknown) => Promise<T>) => fn(db)),
  };
});

// Keep the real `Prisma` namespace: modules loaded by jobs (events/stream.ts)
// use Prisma.sql / Prisma error classes at import time.
vi.mock('@openlinear/db', async () => {
  const actual = await vi.importActual<typeof import('@openlinear/db')>('@openlinear/db');
  return { prisma: db, Prisma: actual.Prisma };
});

const pruneIdempotencyRecordsMock = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('../services/idempotency', () => ({ pruneIdempotencyRecords: pruneIdempotencyRecordsMock }));

import { JOB_NAMES, startPgBoss } from '../jobs';

const QUEUES = [
  JOB_NAMES.sessionPurge,
  JOB_NAMES.invitationExpiry,
  JOB_NAMES.outboxPrune,
  JOB_NAMES.auditRetention,
  JOB_NAMES.attachmentSweep,
  JOB_NAMES.idempotencyPrune,
  // W05a: the execution lease sweeper (every minute).
  JOB_NAMES.executionLeaseSweep,
  // W20: recurring issues (every minute).
  JOB_NAMES.scheduleRun,
  // FE-14: webhook fan-out + delivery (every minute) and delivery retention (daily).
  JOB_NAMES.webhookDeliver,
  JOB_NAMES.webhookPrune,
];

describe('startPgBoss wiring', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const savedJobs = process.env.OPENLINEAR_JOBS;

  beforeEach(() => {
    // startPgBoss is a no-op under NODE_ENV=test; pg-boss itself is mocked.
    process.env.NODE_ENV = 'development';
    delete process.env.OPENLINEAR_JOBS;
    boss.calls.length = 0;
    boss.handlers.clear();
    boss.listeners.length = 0;
    boss.constructed.length = 0;
    boss.failScheduleOn = null;
    boss.stopOptions.length = 0;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedJobs === undefined) delete process.env.OPENLINEAR_JOBS;
    else process.env.OPENLINEAR_JOBS = savedJobs;
  });

  it('creates every queue before working or scheduling it, including the idempotency prune', async () => {
    const started = await startPgBoss();

    expect(started).not.toBeNull();
    expect(boss.constructed).toEqual([expect.objectContaining({ schema: 'pgboss' })]);
    expect(boss.listeners).toContain('error');
    for (const name of QUEUES) {
      const created = boss.calls.indexOf(`createQueue:${name}`);
      const worked = boss.calls.indexOf(`work:${name}`);
      const scheduled = boss.calls.findIndex((call) => call.startsWith(`schedule:${name}:`));
      expect(created, name).toBeGreaterThan(boss.calls.indexOf('start'));
      expect(worked, name).toBeGreaterThan(created);
      expect(scheduled, name).toBeGreaterThan(created);
    }
    expect([...boss.handlers.keys()].sort()).toEqual([...QUEUES].sort());

    await started?.stop();
    expect(boss.stopOptions).toHaveLength(1);
  });

  it('never passes the pg-boss job batch into job parameters', async () => {
    await startPgBoss();
    const before = Date.now();

    await boss.handlers.get(JOB_NAMES.outboxPrune)?.([{ id: 'job-1', name: JOB_NAMES.outboxPrune, data: {} }]);

    // W04b: retention selects a bounded batch by createdAt inside a transaction.
    expect(db.domainEvent.findMany).toHaveBeenCalledOnce();
    const where = db.domainEvent.findMany.mock.calls[0]?.[0] as { where: { createdAt: { lte: Date } } };
    const cutoff = where.where.createdAt.lte.getTime();
    expect(Number.isNaN(cutoff)).toBe(false);
    expect(before - cutoff).toBeGreaterThanOrEqual(48 * 60 * 60 * 1000 - 1_000);
  });

  it('runs both idempotency prunes from one queue', async () => {
    await startPgBoss();

    await boss.handlers.get(JOB_NAMES.idempotencyPrune)?.([{ id: 'job-2' }]);

    expect(db.idempotencyKey.deleteMany).toHaveBeenCalledOnce();
    expect(pruneIdempotencyRecordsMock).toHaveBeenCalledOnce();
  });

  it('stops a partially started pg-boss and returns null, so the fallback never runs beside it', async () => {
    boss.failScheduleOn = JOB_NAMES.outboxPrune;

    const started = await startPgBoss();

    expect(started).toBeNull();
    expect(boss.calls).toContain(`work:${JOB_NAMES.sessionPurge}`);
    expect(boss.stopOptions).toEqual([{ graceful: false }]);
  });

  it('stays off when OPENLINEAR_JOBS=0 or under NODE_ENV=test', async () => {
    process.env.OPENLINEAR_JOBS = '0';
    await expect(startPgBoss()).resolves.toBeNull();

    delete process.env.OPENLINEAR_JOBS;
    process.env.NODE_ENV = 'test';
    await expect(startPgBoss()).resolves.toBeNull();

    expect(boss.constructed).toHaveLength(0);
  });
});
