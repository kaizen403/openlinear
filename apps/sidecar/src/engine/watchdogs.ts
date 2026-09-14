export interface WatchdogBudgets {
  transportMs: number;
  noProgressMs: number;
  maxTokens?: number;
  maxUsd?: number;
  wallClockMs: number;
}

export interface WatchdogState {
  suspended: boolean;
  lastTransportAt: number;
  lastProgressAt: number;
  startedAt: number;
  tokens: number;
  usd: number;
}

export type WatchdogTrip =
  | { kind: 'transport' }
  | { kind: 'no-progress' }
  | { kind: 'budget'; reason: 'tokens' | 'usd' | 'wall-clock' };

const APPROVAL_DEADLINE_MS = 10 * 60 * 1000;

export function createWatchdogState(now = Date.now()): WatchdogState {
  return {
    suspended: false,
    lastTransportAt: now,
    lastProgressAt: now,
    startedAt: now,
    tokens: 0,
    usd: 0,
  };
}

export function defaultBudgets(): WatchdogBudgets {
  const raw = parseInt(process.env.OPENLINEAR_NO_PROGRESS_TIMEOUT_MS || '', 10);
  return {
    transportMs: 60_000,
    noProgressMs: Number.isFinite(raw) && raw > 0 ? raw : 20 * 60 * 1000,
    wallClockMs: 6 * 60 * 60 * 1000,
  };
}

export function touchTransport(state: WatchdogState, now = Date.now()): void {
  state.lastTransportAt = now;
}

export function touchProgress(state: WatchdogState, now = Date.now()): void {
  state.lastTransportAt = now;
  state.lastProgressAt = now;
}

export function recordUsage(state: WatchdogState, tokens: number, usd: number): void {
  state.tokens += tokens;
  state.usd += usd;
}

export function checkWatchdogs(state: WatchdogState, budgets: WatchdogBudgets, now = Date.now()): WatchdogTrip | null {
  if (state.suspended) return null;
  if (now - state.lastTransportAt > budgets.transportMs) return { kind: 'transport' };
  if (now - state.lastProgressAt > budgets.noProgressMs) return { kind: 'no-progress' };
  if (now - state.startedAt > budgets.wallClockMs) return { kind: 'budget', reason: 'wall-clock' };
  if (budgets.maxTokens !== undefined && state.tokens >= budgets.maxTokens) {
    return { kind: 'budget', reason: 'tokens' };
  }
  if (budgets.maxUsd !== undefined && state.usd >= budgets.maxUsd) {
    return { kind: 'budget', reason: 'usd' };
  }
  return null;
}

export function approvalDeadlineExceeded(requestedAt: number, now = Date.now()): boolean {
  return now - requestedAt >= APPROVAL_DEADLINE_MS;
}
