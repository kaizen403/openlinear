#!/usr/bin/env node
/**
 * Nightly / local-only. Not a PR gate.
 * Documents the 300MB warm-path budget (~2.7s) from the Phase 2 plan.
 */
console.log(JSON.stringify({
  name: 'openlinear-execution-latency-300mb',
  fixtureBytes: 300 * 1024 * 1024,
  targetMs: 2700,
  gate: false,
}));
