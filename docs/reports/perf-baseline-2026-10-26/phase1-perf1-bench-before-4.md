# API benchmark: phase1-perf1-before-4

Generated 2026-10-26T09:11:52.097Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-before-4.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 6.21, max 7.53. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.53 | 0.77 | 1.39 | 0.68–3.18 | 0.58 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 0.84 | 1.24 | 1.55 | 0.97–11.11 | 0.91 | 6 (6) | 654 | 0 |
| shell.workspace-structure | 300 | 12.64 | 14.98 | 24.73 | 14.42–23.87 | 13.93 | 9 (9) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 11.91 | 13.44 | 13.81 | 13.14–18.37 | 12.95 | 9 (9) | 760917 | 0 |
| board.project-large | 300 | 15.77 | 18.2 | 19.96 | 16.09–25.25 | 17.62 | 15 (19) | 416635 | 0 |
| board.project-large.pat | 300 | 15.47 | 17.89 | 20.32 | 17.76–18.54 | 17.47 | 16 (16) | 416635 | 0 |
| task.get | 300 | 1.16 | 1.63 | 2.26 | 1.6–3.06 | 1.46 | 13 (17) | 2157 | 0 |
| task.comments | 300 | 0.98 | 1.49 | 1.79 | 1.31–1.53 | 1.15 | 9 (9) | 1579 | 0 |
| inbox.list | 300 | 33.66 | 39.51 | 45.29 | 32.71–42.48 | 39.05 | 7 (11) | 127262 | 0 |
| inbox.count | 300 | 16.01 | 22.89 | 25.99 | 17.38–29.78 | 22.35 | 2 (2) | 29 | 0 |
| notifications.page | 300 | 5.43 | 22.84 | 27.77 | 19.62–26.53 | 22.52 | 5 (5) | 47093 | 0 |
| notifications.page.owner | 300 | 23.11 | 32.52 | 35.56 | 21.27–44.03 | 31.99 | 5 (5) | 47267 | 0 |
| notifications.badge | 300 | 3.92 | 18.27 | 19.35 | 17.99–24.03 | 18.08 | 5 (9) | 549 | 0 |
| dashboard.tasks | 300 | 19.79 | 23.62 | 26.36 | 21.11–24.27 | 23.07 | 6 (10) | 191 | 0 |
| dashboard.projects | 300 | 6.29 | 7.89 | 8.24 | 6.67–8.87 | 7.49 | 4 (8) | 4458 | 0 |
| usage.summary | 300 | 38.05 | 49 | 55.54 | 43.59–54.9 | 47.68 | 3 (3) | 2529 | 0 |
| usage.by-task | 300 | 52.81 | 62.56 | 67.36 | 59.9–71.61 | 62.05 | 4 (8) | 9257 | 0 |
| usage.mcp | 300 | 0.56 | 9.89 | 10.53 | 9.26–9.96 | 9.35 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 10.22 | 12.37 | 14.99 | 10.85–14.37 | 11.2 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 167.83 | 214.17 | 241.37 | 194.69–263.13 | 213.64 | 4.32 (8) | 26575 | 0 |
| activity.project | 300 | 4.33 | 4.86 | 6.32 | 4.75–5.2 | 4.52 | 9 (13) | 26572 | 0 |
| activity.feed.deep-offset | 300 | 328.03 | 391.16 | 425.82 | 390.99–440.86 | 390.7 | 4.64 (8) | 22920 | 0 |
| activity.feed.cursor | 300 | 168.78 | 201.26 | 216.79 | 190.92–231.31 | 200.66 | 4.63 (8) | 26573 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| cb0f74d1992d | 383 | 227.05 | 485.14 | /api/activity |
| 455b29d81016 | 97 | 105.11 | 130.24 | /api/activity |

