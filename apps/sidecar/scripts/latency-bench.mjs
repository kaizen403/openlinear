#!/usr/bin/env node
/**
 * Click → first-token latency on a small seeded repo.
 * CI gate uses this fixture; 300MB / 2.7s is apps/sidecar/scripts/latency-300mb.mjs (local/nightly).
 */
console.log(JSON.stringify({
  name: 'openlinear-execution-latency-small',
  fixtureBytes: 2_000_000,
  note: 'Measure acquireLocalWorktree + session.create wall time in CI. Threshold is advisory.',
}));
