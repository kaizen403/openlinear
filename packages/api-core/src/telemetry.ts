export interface TelemetryHooks {
  count(name: string, value?: number, attributes?: Record<string, string>): void;
  histogram(name: string, value: number, attributes?: Record<string, string>): void;
  gauge(name: string, value: number, attributes?: Record<string, string>): void;
}

const noops: TelemetryHooks = {
  count() {},
  histogram() {},
  gauge() {},
};

let hooks: TelemetryHooks = noops;

export function setTelemetryHooks(next: TelemetryHooks): void {
  hooks = next;
}

export function telemetry(): TelemetryHooks {
  return hooks;
}

export const RATE_LIMIT_POLICIES = {
  default: { windowMs: 60_000, max: 100 },
  auth: { windowMs: 60_000, max: 60 },
  "github-oauth": { windowMs: 60_000, max: 120 },
  "repos-url": { windowMs: 60_000, max: 10 },
  events: { windowMs: 60_000, max: 30 },
} as const;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;
