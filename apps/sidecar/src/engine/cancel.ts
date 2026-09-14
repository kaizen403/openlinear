import type { AgentSession } from '@openlinear/execution-core';

const INTERRUPT_GRACE_MS = process.env.NODE_ENV === 'test'
  ? Number(process.env.OPENLINEAR_INTERRUPT_GRACE_MS ?? 0)
  : Number(process.env.OPENLINEAR_INTERRUPT_GRACE_MS ?? 15_000);

export interface CancelTarget {
  session?: AgentSession | null;
  pgid?: number;
  signal?: AbortController;
}

/**
 * interrupt → 15s → abort → kill(-pgid). One AbortController per run.
 */
export async function cancelRun(target: CancelTarget, waitMs = INTERRUPT_GRACE_MS): Promise<void> {
  target.signal?.abort();
  if (target.session) {
    try {
      await target.session.interrupt();
    } catch {
      // interrupt is best-effort
    }
  }

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (target.session) {
    try {
      await target.session.abort();
    } catch {
      // abort is best-effort
    }
  }

  if (typeof target.pgid === 'number') {
    try {
      process.kill(-target.pgid, 'SIGKILL');
    } catch {
      // process group may already be gone
    }
  }
}
