import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBroker, approvalDigest } from './approvals';

afterEach(() => vi.useRealTimers());

function broker(onChange = vi.fn()) {
  let now = 1_000;
  const instance = new ApprovalBroker({ now: () => now, onChange });
  return { instance, onChange, tick: (ms: number) => { now += ms; } };
}

const REQUEST = { runId: 'run-1', taskId: 'task-1', ownerUserId: 'u1', requestId: 'perm-1', tool: 'bash', detail: 'rm -rf build' };

describe('FE-04 approval broker', () => {
  it('lets the owner decide the operation they were shown, once', async () => {
    const { instance, onChange } = broker();
    const { approval, outcome } = instance.request(REQUEST);
    expect(approval.digest).toBe(approvalDigest(REQUEST));
    expect(instance.pendingFor('task-1').map((entry) => entry.id)).toEqual([approval.id]);
    const decided = instance.decide({ approvalId: approval.id, taskId: 'task-1', decision: 'allow', digest: approval.digest, userId: 'u1' });
    expect(decided).toMatchObject({ decision: 'allow', scope: 'once', by: 'user', userId: 'u1' });
    await expect(outcome).resolves.toMatchObject({ decision: 'allow', by: 'user' });
    expect(instance.pendingFor('task-1')).toEqual([]);
    // A replay finds nothing to approve.
    expect(() => instance.decide({ approvalId: approval.id, taskId: 'task-1', decision: 'allow', digest: approval.digest, userId: 'u1' }))
      .toThrow(expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' }));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('refuses a changed operation, another user, another task, and an expired request', async () => {
    const { instance, tick } = broker();
    const { approval, outcome } = instance.request({ ...REQUEST, timeoutMs: 60_000 });
    expect(() => instance.decide({ approvalId: approval.id, taskId: 'task-1', decision: 'allow', digest: 'x'.repeat(64), userId: 'u1' }))
      .toThrow(expect.objectContaining({ statusCode: 409, code: 'APPROVAL_CHANGED' }));
    expect(() => instance.decide({ approvalId: approval.id, taskId: 'task-1', decision: 'allow', digest: approval.digest, userId: 'u2' }))
      .toThrow(expect.objectContaining({ statusCode: 403, code: 'APPROVAL_FORBIDDEN' }));
    expect(() => instance.decide({ approvalId: approval.id, taskId: 'task-2', decision: 'allow', digest: approval.digest, userId: 'u1' }))
      .toThrow(expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' }));
    tick(60_000);
    expect(() => instance.decide({ approvalId: approval.id, taskId: 'task-1', decision: 'allow', digest: approval.digest, userId: 'u1' }))
      .toThrow(expect.objectContaining({ code: 'APPROVAL_NOT_FOUND' }));
    instance.cancelRun('run-1');
    await expect(outcome).resolves.toMatchObject({ decision: 'deny', by: 'cancel' });
  });

  it('denies at the deadline and when the run is cancelled', async () => {
    vi.useFakeTimers();
    const instance = new ApprovalBroker();
    const timed = instance.request({ ...REQUEST, timeoutMs: 5_000 });
    vi.advanceTimersByTime(5_000);
    await expect(timed.outcome).resolves.toMatchObject({ decision: 'deny', by: 'timeout', userId: null });
    const first = instance.request({ ...REQUEST, requestId: 'perm-2' });
    const second = instance.request({ ...REQUEST, requestId: 'perm-3' });
    const other = instance.request({ ...REQUEST, runId: 'run-2', taskId: 'task-2', requestId: 'perm-4' });
    expect(instance.cancelRun('run-1')).toBe(2);
    await expect(first.outcome).resolves.toMatchObject({ decision: 'deny', by: 'cancel' });
    await expect(second.outcome).resolves.toMatchObject({ decision: 'deny', by: 'cancel' });
    expect(instance.pendingFor('task-2').map((entry) => entry.id)).toEqual([other.approval.id]);
  });
});
