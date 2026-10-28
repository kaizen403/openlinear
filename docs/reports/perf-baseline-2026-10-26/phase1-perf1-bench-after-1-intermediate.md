# API benchmark: phase1-perf1-after-1

Generated 2026-10-26T08:43:35.374Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-after-1-intermediate.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 12.05, max 15.89. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.86 | 1.39 | 1.67 | 1.3–2.06 | 0.93 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 0.92 | 1.44 | 1.87 | 1.29–1.8 | 1.04 | 2 (2) | 654 | 0 |
| shell.workspace-structure | 300 | 14.65 | 17.76 | 19.4 | 17.11–17.83 | 16.63 | 9 (9) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 5.4 | 6.94 | 7.59 | 6.29–7.28 | 6.45 | 6 (6) | 39651 | 0 |
| board.project-large | 300 | 16.85 | 18.51 | 22.78 | 18.4–22.33 | 17.82 | 11 (11) | 416635 | 0 |
| board.project-large.pat | 300 | 16.66 | 20.01 | 21.39 | 18.79–20.22 | 18.98 | 12 (12) | 416635 | 0 |
| task.get | 300 | 1.49 | 2.19 | 3.26 | 1.98–2.73 | 1.9 | 9 (9) | 2157 | 0 |
| task.comments | 300 | 1.39 | 2.28 | 2.69 | 1.37–2.29 | 1.92 | 5 (5) | 1579 | 0 |
| inbox.list | 300 | 22.55 | 24.57 | 28.17 | 24.11–39.31 | 24.09 | 6 (6) | 127262 | 0 |
| inbox.count | 300 | 7.46 | 8.29 | 8.78 | 8.01–20.48 | 7.8 | 1 (1) | 29 | 0 |
| notifications.page | 300 | 13.45 | 16.13 | 18.02 | 15.05–20.63 | 15.67 | 3 (7) | 47093 | 0 |
| notifications.page.owner | 300 | 16.46 | 20.73 | 22.96 | 16.61–21.44 | 20.18 | 3 (3) | 47267 | 0 |
| notifications.badge | 300 | 13.93 | 16.94 | 17.57 | 14.83–19.94 | 16.54 | 3.04 (7) | 549 | 0 |
| dashboard.tasks | 300 | 12.13 | 16.66 | 18.31 | 10.6–23.76 | 15.97 | 1 (5) | 191 | 0 |
| dashboard.projects | 300 | 8.12 | 10.02 | 11.2 | 7.99–10.34 | 9.39 | 4 (8) | 4458 | 0 |
| usage.summary | 300 | 27.62 | 115.55 | 167.71 | 28.68–236.32 | 114.91 | 1.2 (5) | 2529 | 0 |
| usage.by-task | 300 | 47.62 | 79.42 | 92.82 | 46.55–87.93 | 78.59 | 1 (5) | 9257 | 0 |
| usage.mcp | 300 | 0.56 | 9.98 | 11.02 | 9.96–10.77 | 9.76 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 10.99 | 12.64 | 18.63 | 12.44–14.73 | 11.29 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 1.56 | 2.36 | 2.65 | 2.19–2.99 | 1.88 | 2 (2) | 26673 | 0 |
| activity.project | 300 | 1.36 | 2.76 | 3.13 | 2.05–2.94 | 2.28 | 3 (3) | 26673 | 0 |
| activity.feed.deep-offset | 300 | 271.31 | 300.4 | 333.48 | 269.17–533.21 | 299.45 | 2.64 (6) | 23036 | 0 |
| activity.feed.cursor | 300 | 2.07 | 2.73 | 3.1 | 2.66–2.96 | 2.3 | 2 (2) | 22802 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 5136626a803d | 330 | 267.69 | 1489.54 | /api/activity |
| de507a5796ea | 20 | 166.54 | 1055.34 | /api/usage/summary |
| 128b3fada57f | 14 | 131.6 | 654.16 | /api/usage/by-task |

