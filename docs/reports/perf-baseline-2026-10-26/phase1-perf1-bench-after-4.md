# API benchmark: phase1-perf1-after-4

Generated 2026-10-26T09:06:10.976Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-after-4.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 4.71, max 5.41. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.81 | 1.61 | 1.94 | 1.44–1.7 | 1.16 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 0.82 | 1.06 | 1.49 | 0.83–1.26 | 0.78 | 2 (2) | 654 | 0 |
| shell.workspace-structure | 300 | 13.07 | 15 | 16.65 | 14.69–18.92 | 14.05 | 9 (9) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 5.2 | 5.98 | 6.18 | 5.84–6.28 | 5.42 | 6 (6) | 39651 | 0 |
| board.project-large | 300 | 17.14 | 20.53 | 23.43 | 20.13–21.62 | 19.87 | 11 (11) | 416635 | 0 |
| board.project-large.pat | 300 | 17.59 | 22.23 | 24.46 | 20.37–23.17 | 21.33 | 12 (12) | 416635 | 0 |
| task.get | 300 | 1.7 | 2.31 | 2.57 | 2.14–4.55 | 1.99 | 9 (9) | 2157 | 0 |
| task.comments | 300 | 1.59 | 2.15 | 2.42 | 1.68–3.35 | 1.76 | 5 (5) | 1579 | 0 |
| inbox.list | 300 | 22.73 | 27.65 | 29.43 | 25.69–35.36 | 27.1 | 6 (6) | 127262 | 0 |
| inbox.count | 300 | 7.43 | 8.78 | 10.07 | 8.51–8.87 | 8.17 | 1 (1) | 29 | 0 |
| notifications.page | 300 | 2.89 | 8.93 | 10.18 | 8.41–9.48 | 8.61 | 3 (3) | 47093 | 0 |
| notifications.page.owner | 300 | 9.63 | 11.71 | 12.73 | 10.26–12.3 | 11.25 | 3 (3) | 47267 | 0 |
| notifications.badge | 300 | 2.3 | 8.29 | 9.27 | 7.24–8.36 | 8 | 3 (3) | 549 | 0 |
| dashboard.tasks | 300 | 8.46 | 9.44 | 9.93 | 9.44–9.56 | 9.08 | 1 (1) | 191 | 0 |
| dashboard.projects | 300 | 7.15 | 8.19 | 8.9 | 7.51–8.87 | 7.83 | 4 (8) | 4458 | 0 |
| usage.summary | 300 | 18.83 | 25.45 | 26.44 | 21.65–26.02 | 24.93 | 1 (5) | 2529 | 0 |
| usage.by-task | 300 | 34.28 | 41.31 | 44.72 | 38.31–55.9 | 40.93 | 1 (5) | 9257 | 0 |
| usage.mcp | 300 | 0.57 | 9.5 | 11.12 | 9.03–10.28 | 9.26 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 9.66 | 10.94 | 12.33 | 10.42–14.27 | 9.94 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 1.23 | 2 | 2.42 | 1.8–2.37 | 1.73 | 2 (2) | 26673 | 0 |
| activity.project | 300 | 1.02 | 1.66 | 2.32 | 1.5–2.11 | 1.35 | 3 (3) | 26673 | 0 |
| activity.feed.deep-offset | 300 | 240.24 | 285.51 | 317.76 | 266.01–291.03 | 282.92 | 2.64 (6) | 23036 | 0 |
| activity.feed.cursor | 300 | 1.9 | 2.5 | 2.82 | 1.95–2.57 | 1.98 | 2 (2) | 22802 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 5136626a803d | 330 | 235.25 | 462.97 | /api/activity |

