import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TokenUsage } from '@openlinear/execution-core';
import { runnerRecordsDir, type RunnerProcessId } from './sandboxed-process';

/**
 * Host-side per-session usage baselines. Some runtimes (Claude Code) report
 * conversation-cumulative totals on a resumed session; the baseline recorded
 * at the end of the previous run lets the adapter emit only this run's share.
 * Stored next to the sandbox records, which agents cannot read or write.
 */
export interface SessionUsageRecord {
  usage: TokenUsage;
  costUsd: number;
  updatedAt: string;
}

function recordPath(runner: RunnerProcessId, sessionId: string, env: NodeJS.ProcessEnv): string {
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return join(runnerRecordsDir(env), 'sessions', `${runner}-${digest}.json`);
}

function isUsage(value: unknown): value is TokenUsage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'].every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]));
}

export function readSessionUsage(runner: RunnerProcessId, sessionId: string, env: NodeJS.ProcessEnv = process.env): SessionUsageRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(runner, sessionId, env), 'utf8')) as Record<string, unknown>;
    if (!isUsage(parsed.usage) || typeof parsed.costUsd !== 'number' || typeof parsed.updatedAt !== 'string') return null;
    return { usage: parsed.usage, costUsd: parsed.costUsd, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

export function writeSessionUsage(runner: RunnerProcessId, sessionId: string, record: SessionUsageRecord, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = recordPath(runner, sessionId, env);
    mkdirSync(join(runnerRecordsDir(env), 'sessions'), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
  } catch {
    // Best effort: a missing baseline only degrades resumed-run accounting
    // to the per-message lower bound.
  }
}
