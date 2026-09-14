import { decideRecovery, type JournalRun } from '@openlinear/execution-core';
import type { AgentRunner } from '@openlinear/execution-core';
import { logger } from '@openlinear/api/logger';
import { RunJournal } from '../../journal/sqlite';
import { hasCommittableChanges } from './git';
import { getSidecarStore } from '../../persistence/store';

export interface RecoveryResult {
  recovered: number;
  orphaned: number;
  resumed: number;
  salvaged: number;
  failed: number;
}

export interface RecoveryDeps {
  journal: RunJournal;
  runner?: AgentRunner | null;
  now?: number;
  hasDiff?: (worktreePath: string | null) => Promise<boolean>;
}

async function defaultHasDiff(worktreePath: string | null): Promise<boolean> {
  if (!worktreePath) return false;
  try {
    return await hasCommittableChanges(worktreePath);
  } catch {
    return false;
  }
}

async function probeRunner(runner: AgentRunner | null | undefined, externalId: string | null): Promise<{ found: boolean; busy: boolean }> {
  if (!externalId || !runner) return { found: false, busy: false };
  try {
    const session = await runner.resume(externalId, {
      worktreePath: '',
      signal: new AbortController().signal,
    });
    return { found: Boolean(session), busy: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\b404\b/.test(message)) return { found: false, busy: false };
    return { found: false, busy: false };
  }
}

export async function recoverInFlightExecutions(deps?: RecoveryDeps): Promise<RecoveryResult> {
  const result: RecoveryResult = { recovered: 0, orphaned: 0, resumed: 0, salvaged: 0, failed: 0 };
  const journal = deps?.journal;
  if (!journal) {
    logger.info('[Recovery] no journal provided — skipping');
    return result;
  }

  const now = deps?.now ?? Date.now();
  const runs = journal.listRunning();
  if (runs.length === 0) {
    logger.info('[Recovery] no in-flight journal runs');
    return result;
  }

  for (const run of runs) {
    const { found, busy } = await probeRunner(deps?.runner, run.externalSessionId);
    const hasDiff = await (deps?.hasDiff ?? defaultHasDiff)(run.worktreePath);
    const action = decideRecovery({
      status: run.status,
      heartbeatAt: Number(run.heartbeatAt),
      now,
      runnerFound: found,
      runnerBusy: busy,
      hasDiff,
    });

    logger.info({ runId: run.id, action }, '[Recovery] journal decision');

    if (action === 'RESUME') {
      result.resumed += 1;
      result.recovered += 1;
      continue;
    }
    if (action === 'SALVAGE' || action === 'COMPLETE_IDEMPOTENT') {
      journal.setStatus(run.id, 'completing');
      result.salvaged += 1;
      result.recovered += 1;
      await markTaskFromJournal(run, action === 'SALVAGE' ? 'salvaged' : 'completing');
      continue;
    }

    journal.setStatus(run.id, 'failed', Date.now());
    result.failed += 1;
    result.orphaned += 1;
    await markTaskFromJournal(run, 'failed');
  }

  return result;
}

async function markTaskFromJournal(run: JournalRun, outcome: string): Promise<void> {
  try {
    const store = await getSidecarStore();
    await store.updateTask(run.taskId, {
      status: outcome === 'failed' ? 'cancelled' : undefined,
      outcome: `sidecar_recovery_${outcome}`,
    });
    await store.updateAgentRun(run.id, {
      status: outcome === 'failed' ? 'failed' : 'running',
      errorMessage: outcome === 'failed' ? 'sidecar_restart_orphan' : null,
    });
  } catch (err) {
    logger.warn({ err, runId: run.id }, '[Recovery] store update failed (non-fatal)');
  }
}

export async function recoverActiveBatches(): Promise<RecoveryResult> {
  logger.info('[Recovery] batch membership is recovered via journal runs');
  return { recovered: 0, orphaned: 0, resumed: 0, salvaged: 0, failed: 0 };
}
