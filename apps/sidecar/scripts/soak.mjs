#!/usr/bin/env node
/**
 * 6-hour / 2M token soak. Not a PR gate — run locally or as a nightly job.
 */
console.log(JSON.stringify({
  name: 'openlinear-execution-soak',
  durationHours: 6,
  tokenBudget: 2_000_000,
  watchdog: 'tool-call 10m',
  gate: false,
}));
