# API benchmark: phase1-perf1-after-3

Generated 2026-10-26T09:03:35.083Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-after-3.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 5.47, max 6.97. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.57 | 1.28 | 1.6 | 1.17–1.58 | 0.91 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 0.63 | 1.01 | 1.47 | 0.9–1.31 | 0.75 | 2 (2) | 654 | 0 |
| shell.workspace-structure | 300 | 12.32 | 14.72 | 16.83 | 14.22–16.65 | 14 | 9 (9) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 4.76 | 5.68 | 6.36 | 5.06–6.23 | 5.22 | 6 (6) | 39651 | 0 |
| board.project-large | 300 | 14.87 | 16.82 | 17.59 | 16.44–18.68 | 16.06 | 11 (11) | 416635 | 0 |
| board.project-large.pat | 300 | 15.02 | 17.1 | 17.54 | 16.18–21.03 | 16.53 | 12 (12) | 416635 | 0 |
| task.get | 300 | 1.17 | 1.68 | 2.45 | 1.42–2.04 | 1.46 | 9 (9) | 2157 | 0 |
| task.comments | 300 | 0.85 | 1.12 | 1.3 | 0.93–2.91 | 0.87 | 5 (5) | 1579 | 0 |
| inbox.list | 300 | 20.02 | 23.13 | 24.71 | 20.5–24.41 | 22.19 | 6 (6) | 127262 | 0 |
| inbox.count | 300 | 6.49 | 8.31 | 8.59 | 7.54–17.97 | 7.88 | 1 (1) | 29 | 0 |
| notifications.page | 300 | 3.2 | 9 | 12.31 | 8.93–17.32 | 8.72 | 3 (3) | 47093 | 0 |
| notifications.page.owner | 300 | 9.15 | 11.41 | 12.88 | 11.15–12.64 | 10.82 | 3 (3) | 47267 | 0 |
| notifications.badge | 300 | 2.16 | 8.03 | 8.55 | 7.14–8.26 | 7.78 | 3 (3) | 549 | 0 |
| dashboard.tasks | 300 | 8.45 | 11.12 | 12.09 | 9.14–11.66 | 10.52 | 1 (5) | 191 | 0 |
| dashboard.projects | 300 | 6.79 | 7.22 | 7.54 | 7.01–7.78 | 6.84 | 4 (8) | 4458 | 0 |
| usage.summary | 300 | 20 | 27.3 | 31.34 | 22.32–28.36 | 26.9 | 1 (5) | 2529 | 0 |
| usage.by-task | 300 | 36.41 | 40.16 | 44.96 | 37.07–44.61 | 39.75 | 1 (1) | 9257 | 0 |
| usage.mcp | 300 | 0.58 | 9.93 | 10.72 | 9.64–10.02 | 9.65 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 10.07 | 11.75 | 14.24 | 11.31–11.83 | 10.61 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 1.44 | 2.07 | 2.28 | 1.84–2.45 | 1.67 | 2 (2) | 26673 | 0 |
| activity.project | 300 | 1.14 | 1.98 | 2.13 | 1.52–2.21 | 1.44 | 3 (3) | 26673 | 0 |
| activity.feed.deep-offset | 300 | 226.45 | 262.24 | 286.28 | 249.37–269.93 | 261.71 | 2.64 (6) | 23036 | 0 |
| activity.feed.cursor | 300 | 1.72 | 2.38 | 2.92 | 1.88–3.07 | 1.96 | 2 (6) | 22802 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 5136626a803d | 330 | 232.09 | 409.26 | /api/activity |

