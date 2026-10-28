# API benchmark: phase1-perf1-before-2

Generated 2026-10-26T08:51:18.369Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-before-2.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 13.07, max 22.34. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.77 | 1.74 | 2.46 | 0.77–7.53 | 1.45 | 2.04 (8) | 307 | 0 |
| shell.workspaces | 300 | 1.47 | 1.96 | 2.36 | 1.35–3.57 | 1.63 | 6 (6) | 654 | 0 |
| shell.workspace-structure | 300 | 13.96 | 15.93 | 26.65 | 14.83–43.27 | 15.01 | 9 (13) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 13.6 | 15.6 | 16.37 | 15.13–24.94 | 14.98 | 9.12 (13) | 760917 | 0 |
| board.project-large | 300 | 16.49 | 18.07 | 18.53 | 17.51–24.37 | 17.52 | 15 (19) | 416635 | 0 |
| board.project-large.pat | 300 | 16.85 | 19.53 | 25.78 | 18.97–21.29 | 19.03 | 16 (16) | 416635 | 0 |
| task.get | 300 | 1.58 | 2.46 | 3.26 | 2.4–3.52 | 2.02 | 13 (17) | 2157 | 0 |
| task.comments | 300 | 1.15 | 1.61 | 1.93 | 1.57–2.15 | 1.43 | 9 (13) | 1579 | 0 |
| inbox.list | 300 | 34.81 | 41.23 | 45.82 | 32.67–51.75 | 39.85 | 7 (11) | 127262 | 0 |
| inbox.count | 300 | 18.59 | 19.72 | 20.18 | 17.24–24.76 | 19.32 | 2 (2) | 29 | 0 |
| notifications.page | 300 | 5.02 | 24.98 | 27.74 | 20.37–26.81 | 24.69 | 5 (5) | 47093 | 0 |
| notifications.page.owner | 300 | 31.57 | 45.68 | 52.99 | 42.58–51.55 | 45.02 | 5 (5) | 47267 | 0 |
| notifications.badge | 300 | 6.05 | 25.63 | 33.07 | 24.35–25.88 | 25.3 | 5 (5) | 549 | 0 |
| dashboard.tasks | 300 | 21.51 | 23.57 | 27.17 | 22.44–25.35 | 23.17 | 6 (6) | 191 | 0 |
| dashboard.projects | 300 | 7.39 | 9.13 | 15.85 | 7.9–11.46 | 8.56 | 4 (4) | 4458 | 0 |
| usage.summary | 300 | 43.43 | 49.06 | 55.92 | 48.98–83.06 | 47.64 | 3 (3) | 2529 | 0 |
| usage.by-task | 300 | 64.01 | 76.69 | 88.97 | 69.4–91.99 | 76.15 | 4.12 (8) | 9257 | 0 |
| usage.mcp | 300 | 0.78 | 10.56 | 11.88 | 9.77–11.21 | 10.29 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 11.04 | 13.37 | 16.76 | 11.29–17.02 | 11.97 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 193.42 | 387.62 | 516.88 | 295.12–788.81 | 386.45 | 4.28 (8) | 26571 | 0 |
| activity.project | 300 | 4.34 | 5.57 | 6.73 | 4.87–16.72 | 5.21 | 9 (13) | 26572 | 0 |
| activity.feed.deep-offset | 300 | 352.03 | 416.05 | 474.33 | 402.19–1991.8 | 415.38 | 4.68 (8) | 22920 | 0 |
| activity.feed.cursor | 300 | 192.38 | 370.5 | 442.41 | 219.16–1335.98 | 369.83 | 4.28 (8) | 26572 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| cb0f74d1992d | 630 | 239.16 | 2720.38 | /api/activity |
| 455b29d81016 | 355 | 115.03 | 610.64 | /api/activity |
| dcaec00da406 | 1 | 110.51 | 110.51 | /api/activity |

