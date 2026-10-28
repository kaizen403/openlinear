# API benchmark: phase1-perf1-after-2

Generated 2026-10-26T08:55:01.075Z by `scripts/perf/bench.ts`. Raw data: `phase1-perf1-bench-after-2-intermediate.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 13.85, max 21.18. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 1.15 | 1.63 | 1.71 | 1.52–5.22 | 1.1 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 1.25 | 1.76 | 2.01 | 1.45–4.44 | 1.35 | 2 (2) | 654 | 0 |
| shell.workspace-structure | 300 | 18.18 | 22.84 | 27.97 | 21.74–25.73 | 21.73 | 9 (9) | 760917 | 0 |
| shell.workspace-structure.summary | 300 | 7.56 | 13.48 | 20.09 | 10.15–23.23 | 10.43 | 6 (6) | 39651 | 0 |
| board.project-large | 300 | 21.44 | 33.18 | 41.01 | 24.22–44.23 | 32.36 | 11 (15) | 416635 | 0 |
| board.project-large.pat | 300 | 27.77 | 40.7 | 52.95 | 19.92–45.38 | 38.39 | 12 (12) | 416635 | 0 |
| task.get | 300 | 2.57 | 4.42 | 5.24 | 2.7–4.57 | 3.84 | 9 (13) | 2157 | 0 |
| task.comments | 300 | 2.4 | 3.11 | 3.33 | 1.7–8.4 | 2.67 | 5 (5) | 1579 | 0 |
| inbox.list | 300 | 28.94 | 30.93 | 34.2 | 25.12–42.75 | 29.77 | 6 (6) | 127262 | 0 |
| inbox.count | 300 | 9.35 | 11.77 | 13.99 | 9–11.87 | 10.69 | 1 (1) | 29 | 0 |
| notifications.page | 300 | 16.99 | 19.25 | 22.78 | 16.12–23.1 | 18.6 | 3 (7) | 47093 | 0 |
| notifications.page.owner | 300 | 17.5 | 19.39 | 20.66 | 14.59–38.98 | 18.54 | 3 (3) | 47267 | 0 |
| notifications.badge | 300 | 14.76 | 16.66 | 16.92 | 12.5–68.38 | 16.2 | 3 (7) | 549 | 0 |
| dashboard.tasks | 300 | 10.36 | 11.42 | 16.09 | 8.91–81.45 | 10.88 | 1 (5) | 191 | 0 |
| dashboard.projects | 300 | 9.31 | 14.05 | 16.76 | 7.55–64.71 | 13.33 | 4 (4) | 4458 | 0 |
| usage.summary | 300 | 27.43 | 42.65 | 57.51 | 23.94–66.46 | 42.22 | 1 (1) | 2529 | 0 |
| usage.by-task | 300 | 43.3 | 50.58 | 57 | 44.6–86.05 | 50.11 | 1 (5) | 9257 | 0 |
| usage.mcp | 300 | 0.81 | 11.19 | 12.4 | 9.91–13.7 | 10.9 | 4 (4) | 1035 | 0 |
| usage.mcp.owner | 300 | 11.92 | 13.87 | 17.96 | 11.33–34.96 | 12.81 | 4 (4) | 1339 | 0 |
| activity.feed | 300 | 1.64 | 2.75 | 3.08 | 2.01–4.56 | 2.03 | 2 (2) | 26673 | 0 |
| activity.project | 300 | 1.15 | 2.33 | 3.2 | 2.11–7.17 | 1.7 | 3 (3) | 26673 | 0 |
| activity.feed.deep-offset | 300 | 256.15 | 325.21 | 674.24 | 323.3–805.11 | 324.73 | 2.64 (6) | 23036 | 0 |
| activity.feed.cursor | 300 | 2.28 | 3.26 | 3.76 | 2.34–3.45 | 2.85 | 2 (2) | 22802 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 5136626a803d | 330 | 260.46 | 1275.79 | /api/activity |
| 4cfdfe7ab80a | 1 | 166.08 | 166.08 | /api/notifications |
| 5155ce3179e9 | 1 | 148.81 | 148.81 | /api/notifications |
| 66445e1d2042 | 1 | 133.9 | 133.9 | /api/dashboard/tasks |
| 7b21f9cc4202 | 1 | 100.3 | 100.3 | /api/tasks |

