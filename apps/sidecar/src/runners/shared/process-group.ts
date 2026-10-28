export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface GroupHandle {
  readonly pid: number | undefined;
  /** Signals the single process (fallback when group signalling fails). */
  killProcess(signal: NodeJS.Signals): boolean;
  readonly exited: Promise<ExitInfo>;
  isExited(): boolean;
}

/**
 * Runner processes are spawned `detached` (their own process group), so a
 * negative pid reaches the runtime and every tool/shell child it started.
 */
export function signalProcessGroup(handle: Pick<GroupHandle, 'pid' | 'killProcess'>, signal: NodeJS.Signals): boolean {
  if (handle.pid !== undefined) {
    try {
      process.kill(-handle.pid, signal);
      return true;
    } catch {
      // Group already gone, or the platform has no group signalling.
    }
  }
  try {
    return handle.killProcess(signal);
  } catch {
    return false;
  }
}

export function waitForExit(exited: Promise<ExitInfo>, timeoutMs: number): Promise<ExitInfo | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
    timer.unref?.();
    void exited.then((info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

export interface TerminationReceipt {
  exit: ExitInfo | null;
  escalation: 'none' | 'SIGTERM' | 'SIGKILL';
}

/**
 * SIGTERM to the group, wait `graceMs`, then SIGKILL to the group and wait up
 * to `killWaitMs`. The receipt carries the observed exit, or null when the
 * process could not be confirmed dead (it is then reported, never assumed).
 */
export async function terminateProcessGroup(handle: GroupHandle, graceMs: number, killWaitMs = 5_000): Promise<TerminationReceipt> {
  if (handle.isExited()) {
    // Reap stragglers that outlived the leader (background shells).
    signalProcessGroup(handle, 'SIGKILL');
    return { exit: await handle.exited, escalation: 'none' };
  }
  signalProcessGroup(handle, 'SIGTERM');
  const graceful = await waitForExit(handle.exited, graceMs);
  if (graceful) {
    signalProcessGroup(handle, 'SIGKILL');
    return { exit: graceful, escalation: 'SIGTERM' };
  }
  signalProcessGroup(handle, 'SIGKILL');
  return { exit: await waitForExit(handle.exited, killWaitMs), escalation: 'SIGKILL' };
}
