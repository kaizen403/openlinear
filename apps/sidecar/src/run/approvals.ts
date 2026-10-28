import { createHash, randomUUID } from 'node:crypto';
import { HttpError } from '../lib/errors';

/**
 * FE-04: permission requests that wait for a person.
 *
 * With the user's approval mode set to "ask", the run service hands each
 * runner permission request (Claude Code, OpenCode) to this broker instead of
 * answering it by policy. A request is bound to its run, its owner (the user
 * who started the run) and an operation digest (run, runner request id, tool,
 * detail). It is decided once:
 *
 * - by the owner, quoting the digest they were shown (a changed operation
 *   answers 409 APPROVAL_CHANGED; a decided, expired or unknown request 404
 *   APPROVAL_NOT_FOUND, so a replay can't approve anything);
 * - by its deadline (denied, `timeout`);
 * - by the run ending or being cancelled (denied, `cancel`).
 *
 * In memory: a pending runner request does not survive a sidecar restart
 * either (the runner session is gone or re-asks).
 */

export type ApprovalDecision = 'allow' | 'deny';
/** `run`: an allow also covers this tool's later requests in the same run. */
export type ApprovalScope = 'once' | 'run';

export interface PendingApproval {
  id: string;
  runId: string;
  taskId: string;
  ownerUserId: string;
  tool: string;
  detail: string;
  /** sha256 of the operation; the decision must quote it. */
  digest: string;
  requestedAt: number;
  expiresAt: number;
}

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** Always `once` for a deny, a timeout or a cancel. */
  scope: ApprovalScope;
  by: 'user' | 'timeout' | 'cancel' | 'withdrawn';
  userId: string | null;
  at: number;
}

interface Entry {
  approval: PendingApproval;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 15 * 60_000;

export function approvalDigest(input: { runId: string; requestId: string; tool: string; detail: string }): string {
  return createHash('sha256').update(JSON.stringify([input.runId, input.requestId, input.tool, input.detail])).digest('hex');
}

export class ApprovalBroker {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: {
    now?: () => number;
    /** Every request and decision (SSE + journal); never throws into the broker. */
    onChange?: (approval: PendingApproval, outcome: ApprovalOutcome | null) => void;
  } = {}) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private notify(approval: PendingApproval, outcome: ApprovalOutcome | null): void {
    try {
      this.deps.onChange?.(approval, outcome);
    } catch {
      // Observers must not break a decision.
    }
  }

  /** Open a request; `outcome` settles exactly once (user, timeout or cancel). */
  request(input: { runId: string; taskId: string; ownerUserId: string; requestId: string; tool: string; detail: string; timeoutMs?: number }): { approval: PendingApproval; outcome: Promise<ApprovalOutcome> } {
    const requestedAt = this.now();
    const timeoutMs = input.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const approval: PendingApproval = {
      id: randomUUID(),
      runId: input.runId,
      taskId: input.taskId,
      ownerUserId: input.ownerUserId,
      tool: input.tool,
      detail: input.detail,
      digest: approvalDigest({ runId: input.runId, requestId: input.requestId, tool: input.tool, detail: input.detail }),
      requestedAt,
      expiresAt: requestedAt + timeoutMs,
    };
    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle(approval.id, { decision: 'deny', scope: 'once', by: 'timeout', userId: null, at: this.now() }), timeoutMs);
      timer.unref?.();
      this.entries.set(approval.id, { approval, resolve, timer });
    });
    this.notify(approval, null);
    return { approval, outcome };
  }

  private settle(id: string, outcome: ApprovalOutcome): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    this.notify(entry.approval, outcome);
    return true;
  }

  /** Pending requests of a task, oldest first. */
  pendingFor(taskId: string): PendingApproval[] {
    return [...this.entries.values()]
      .map((entry) => entry.approval)
      .filter((approval) => approval.taskId === taskId)
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  /** The owner's decision on the operation they were shown. */
  decide(input: { approvalId: string; taskId: string; decision: ApprovalDecision; scope?: ApprovalScope; digest: string; userId: string }): ApprovalOutcome {
    const entry = this.entries.get(input.approvalId);
    if (!entry || entry.approval.taskId !== input.taskId || entry.approval.expiresAt <= this.now()) {
      throw new HttpError(404, 'APPROVAL_NOT_FOUND', 'This approval request is no longer pending');
    }
    if (entry.approval.ownerUserId !== input.userId) {
      throw new HttpError(403, 'APPROVAL_FORBIDDEN', 'Only the person who started this run can answer its approval requests');
    }
    if (entry.approval.digest !== input.digest) {
      throw new HttpError(409, 'APPROVAL_CHANGED', 'The operation changed since it was shown; review it again');
    }
    const outcome: ApprovalOutcome = { decision: input.decision, scope: input.decision === 'allow' ? input.scope ?? 'once' : 'once', by: 'user', userId: input.userId, at: this.now() };
    this.settle(input.approvalId, outcome);
    return outcome;
  }

  /** The runner withdrew the request: nothing is answered, and it leaves every view. */
  withdraw(approvalId: string): boolean {
    return this.settle(approvalId, { decision: 'deny', scope: 'once', by: 'withdrawn', userId: null, at: this.now() });
  }

  /** The run ended or was cancelled: deny whatever it still waits on. */
  cancelRun(runId: string): number {
    let count = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.approval.runId !== runId) continue;
      if (this.settle(entry.approval.id, { decision: 'deny', scope: 'once', by: 'cancel', userId: null, at: this.now() })) count += 1;
    }
    return count;
  }
}
