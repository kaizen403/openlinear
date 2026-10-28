# API benchmark: phase1-perf1-after-5

Generated 2026-10-26T09:14:40.118Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-after-5.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 5.63, max 6.87. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.68 | 1.24 | 1.48 | 1.14–2.66 | 0.88 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 0.99 | 2.37 | 2.96 | 1.73–2.46 | 1.6 | 2 (2) | 654 | 0 |
| shell.workspace-structure | 300 | 13.62 | 15.95 | 17.55 | 15.24–18.98 | 15.34 | 9 (9) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 5.52 | 6.3 | 7.04 | 5.99–7.35 | 5.7 | 6 (6) | 39651 | 0 |
| board.project-large | 300 | 17.19 | 19.83 | 27.07 | 19.66–22.77 | 19.2 | 11 (11) | 416635 | 0 |
| board.project-large.pat | 300 | 16.41 | 17.81 | 19.26 | 17.63–21.11 | 17.36 | 12 (12) | 416635 | 0 |
| task.get | 300 | 1.31 | 1.95 | 2.19 | 1.74–2.11 | 1.71 | 9 (9) | 2157 | 0 |
| task.comments | 300 | 0.97 | 1.56 | 1.97 | 1.29–1.8 | 1.2 | 5 (5) | 1579 | 0 |
| inbox.list | 300 | 22.23 | 25.95 | 30.19 | 25.27–26.86 | 25.23 | 6 (10) | 127262 | 0 |
| inbox.count | 300 | 6.24 | 6.91 | 7.22 | 6.16–7.12 | 6.61 | 1 (5) | 29 | 0 |
| notifications.page | 300 | 2.41 | 8 | 8.64 | 7.69–8.9 | 7.76 | 3 (7) | 47093 | 0 |
| notifications.page.owner | 300 | 8.09 | 9.01 | 10.09 | 8.97–15.53 | 8.66 | 3 (3) | 47267 | 0 |
| notifications.badge | 300 | 2.1 | 7.23 | 11.42 | 7.21–7.25 | 7.03 | 3 (7) | 549 | 0 |
| dashboard.tasks | 300 | 8.6 | 9.87 | 12.17 | 9.74–11.2 | 9.41 | 1 (1) | 191 | 0 |
| dashboard.projects | 300 | 6.71 | 7.59 | 7.97 | 6.91–7.93 | 7.12 | 4 (4) | 4458 | 0 |
| usage.summary | 300 | 20.95 | 27.21 | 31.59 | 22.58–43.39 | 26.73 | 1 (1) | 2529 | 0 |
| usage.by-task | 300 | 38.22 | 45.43 | 56.33 | 40.99–59.98 | 44.81 | 1 (5) | 9257 | 0 |
| usage.mcp | 300 | 0.63 | 10.09 | 11.43 | 9.83–10.32 | 9.84 | 4 (8) | 1035 | 0 |
| usage.mcp.owner | 300 | 10.56 | 13 | 13.93 | 12.6–13.13 | 11.66 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 1.58 | 2.5 | 2.78 | 1.71–2.51 | 1.99 | 2 (6) | 26673 | 0 |
| activity.project | 300 | 1.26 | 2.01 | 3.02 | 2–2.34 | 1.77 | 3 (3) | 26673 | 0 |
| activity.feed.deep-offset | 300 | 239.32 | 304.12 | 358.81 | 268.82–433.98 | 303.34 | 2.64 (6) | 23036 | 0 |
| activity.feed.cursor | 300 | 1.75 | 2.7 | 3.18 | 1.97–3.22 | 2.17 | 2 (2) | 22802 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 5136626a803d | 330 | 242.18 | 584.51 | /api/activity |

