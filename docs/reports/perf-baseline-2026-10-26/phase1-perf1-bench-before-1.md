# API benchmark: phase1-perf1-before

Generated 2026-10-26T08:08:39.223Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-before-1.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 8.5, max 11.94. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 1.39 | 3.31 | 4.88 | 1.07–3.94 | 2.4 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 2.45 | 3.58 | 4.06 | 2.02–5.55 | 3.05 | 6 (6) | 654 | 0 |
| shell.workspace-structure | 300 | 16.99 | 29.56 | 34.71 | 19.64–94.53 | 25.6 | 9 (13) | 760917 | 0 |
| board.project-large | 300 | 19 | 21.53 | 24.44 | 19.66–32.82 | 20.79 | 15 (19) | 416635 | 0 |
| board.project-large.pat | 300 | 18.85 | 25.45 | 30.42 | 21.16–28.34 | 24.54 | 16 (16) | 416635 | 0 |
| task.get | 300 | 1.72 | 2.67 | 3.29 | 2.31–4.54 | 2.15 | 13 (13) | 2157 | 0 |
| task.comments | 300 | 1.34 | 2.1 | 3.2 | 1.58–4.78 | 1.81 | 9 (13) | 1579 | 0 |
| inbox.list | 300 | 38.23 | 49.77 | 56.73 | 45.2–53.54 | 49.28 | 7 (7) | 127262 | 0 |
| inbox.count | 300 | 24.9 | 32.05 | 36.88 | 30.73–34.5 | 31.52 | 2 (2) | 29 | 0 |
| notifications.page | 300 | 7.23 | 30.28 | 47.55 | 25.42–32.38 | 29.88 | 5 (5) | 47093 | 0 |
| notifications.page.owner | 300 | 32.9 | 41.16 | 43.58 | 37.93–56.09 | 40.6 | 5 (5) | 47267 | 0 |
| notifications.badge | 300 | 5.37 | 30.02 | 35.67 | 23.46–36.54 | 29.7 | 5 (5) | 549 | 0 |
| dashboard.tasks | 300 | 23.16 | 26.24 | 30.42 | 25–63.37 | 25.65 | 6 (10) | 191 | 0 |
| dashboard.projects | 300 | 7.38 | 8.24 | 10.45 | 7.85–12.6 | 7.84 | 4 (4) | 4458 | 0 |
| usage.summary | 300 | 45.79 | 57.48 | 62.27 | 52.03–96.85 | 55.65 | 3.24 (7) | 2529 | 0 |
| usage.by-task | 300 | 115.2 | 294.97 | 345.35 | 130.42–420.56 | 294.07 | 4.08 (8) | 9257 | 0 |
| usage.mcp | 300 | 0.78 | 9.96 | 11.32 | 9.65–11.38 | 9.7 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 11.52 | 13.88 | 16.27 | 13.08–15 | 12.64 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 233.66 | 480.47 | 661.8 | 464.49–668.19 | 480.03 | 4.64 (8) | 22642 | 0 |
| activity.project | 300 | 5.39 | 6.9 | 7.35 | 6.05–11.54 | 6.37 | 9 (9) | 23115 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| cb0f74d1992d | 210 | 164.65 | 1116.91 | /api/activity |
| 455b29d81016 | 185 | 105.98 | 227.98 | /api/activity |
| 5e2d4e3c8fcb | 100 | 149.35 | 865.7 | /api/usage/by-task |
| 9f94ff76072a | 2 | 143.03 | 203.19 | /api/usage/summary |
| 505aba87c0ba | 2 | 112.62 | 182.7 | /api/usage/summary |
| fe2ee4362889 | 1 | 116.77 | 116.77 | /api/usage/by-task |
| b847f5c7a4ac | 1 | 108.11 | 108.11 | /api/inbox |

