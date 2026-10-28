# API benchmark: phase1-perf1-before-3

Generated 2026-10-26T09:00:58.490Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-before-3.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 7.95, max 11.87. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.84 | 1.96 | 2.5 | 0.95–2.31 | 1.25 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 1.54 | 1.99 | 2.33 | 1.18–3.61 | 1.63 | 6 (6) | 654 | 0 |
| shell.workspace-structure | 300 | 14.11 | 15.49 | 16.21 | 15.14–22.63 | 15.07 | 9 (9) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 13.93 | 17.07 | 17.92 | 15.19–17.73 | 16.45 | 9 (9) | 760917 | 0 |
| board.project-large | 300 | 17.38 | 21.04 | 24.57 | 18.7–21.28 | 19.83 | 15 (15) | 416635 | 0 |
| board.project-large.pat | 300 | 17.47 | 21.75 | 24.42 | 20.13–23.5 | 21.11 | 16 (16) | 416635 | 0 |
| task.get | 300 | 1.39 | 2.28 | 2.59 | 2.05–2.84 | 1.99 | 13 (13) | 2157 | 0 |
| task.comments | 300 | 0.89 | 1.48 | 1.59 | 1.23–2.48 | 1.31 | 9 (9) | 1579 | 0 |
| inbox.list | 300 | 34.11 | 40.31 | 42.8 | 35.05–86.81 | 39.87 | 7 (11) | 127262 | 0 |
| inbox.count | 300 | 20.92 | 24.27 | 26.12 | 18.74–50.72 | 23.58 | 2 (6) | 29 | 0 |
| notifications.page | 300 | 6.24 | 26.75 | 31.2 | 20.24–35.78 | 26.4 | 5 (5) | 47093 | 0 |
| notifications.page.owner | 300 | 28.15 | 36.53 | 37.92 | 23.35–36.63 | 36.04 | 5 (5) | 47267 | 0 |
| notifications.badge | 300 | 5.51 | 23.57 | 30.2 | 18.83–24.67 | 23.19 | 5 (5) | 549 | 0 |
| dashboard.tasks | 300 | 19.66 | 21.86 | 24.59 | 20.71–22.95 | 21.46 | 6 (10) | 191 | 0 |
| dashboard.projects | 300 | 7.71 | 8.97 | 9.2 | 6.92–10.01 | 8.48 | 4 (8) | 4458 | 0 |
| usage.summary | 300 | 40.92 | 50.24 | 53.27 | 46.33–58.09 | 47.7 | 3 (7) | 2529 | 0 |
| usage.by-task | 300 | 59.49 | 71.27 | 73.58 | 63.24–90.3 | 70.73 | 4.12 (8) | 9257 | 0 |
| usage.mcp | 300 | 0.6 | 10.22 | 11.09 | 10.08–10.22 | 9.84 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 10.82 | 12.78 | 15.69 | 11.75–19.64 | 11.35 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 180.66 | 208.04 | 214.06 | 193.66–268.98 | 207.59 | 4.2 (8) | 26574 | 0 |
| activity.project | 300 | 4.56 | 6.2 | 8.7 | 5.5–7.21 | 5.85 | 9 (9) | 26572 | 0 |
| activity.feed.deep-offset | 300 | 335.55 | 408 | 494.15 | 391.03–453.71 | 407.54 | 4.64 (8) | 22920 | 0 |
| activity.feed.cursor | 300 | 170.54 | 202.2 | 218.21 | 189.58–202.3 | 201.72 | 4.08 (8) | 26573 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| cb0f74d1992d | 376 | 231.63 | 401.66 | /api/activity |
| 455b29d81016 | 155 | 104.61 | 172.37 | /api/activity |
| b847f5c7a4ac | 1 | 107.42 | 107.42 | /api/inbox |

