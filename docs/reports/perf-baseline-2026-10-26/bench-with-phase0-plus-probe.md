# API benchmark: with-phase0-plus-probe

Generated 2026-10-25T08:40:49.489Z by `scripts/perf/bench.ts`. Raw data: `bench-with-phase0-plus-probe.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 5.98, max 6.73. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| search.common | 120 | 37.26 | 39.33 | 40.63 | 0–42.09 | 38.93 | 3 (9) | 1630 | 60 |
| search.rare | 120 | 3.57 | 3.76 | 4.02 | 0–4.02 | 3.49 | 3 (3) | 1065 | 60 |
| search.identifier | 96 | 3.01 | 3.33 | 3.68 | 0–4.17 | 2.99 | 3 (3) | 1030 | 84 |
| search.no-match | 76 | 4.1 | 4.56 | 4.56 | 0–5.12 | 4.22 | 3 (3) | 37 | 104 |
| activity.feed | 300 | 101.2 | 170.14 | 216.19 | 169.54–173.57 | 169.55 | 4 (8) | 26527 | 0 |
| activity.project | 300 | 5.13 | 7.91 | 8.65 | 6.45–11.69 | 7.35 | 9 (9) | 26520 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 455b29d81016 | 165 | 106.5 | 402.1 | /api/activity |

