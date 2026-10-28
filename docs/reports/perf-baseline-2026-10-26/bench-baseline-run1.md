# API benchmark: baseline

Generated 2026-10-25T08:21:12.457Z by `scripts/perf/bench.ts`. Raw data: `bench-baseline.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 5.3, max 7.1. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.82 | 1.36 | 1.56 | 0.97–2.3 | 0.93 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 1.6 | 2.51 | 2.91 | 1.34–2.61 | 2.1 | 6 (6) | 654 | 0 |
| shell.projects.ui-fields | 300 | 4.04 | 4.86 | 5.44 | 4.51–5.28 | 4.16 | 2 (2) | 70141 | 0 |
| shell.projects.default | 300 | 5.06 | 6.18 | 6.5 | 5.73–6.33 | 5.18 | 5 (5) | 107644 | 0 |
| shell.teams.ui-fields | 300 | 0.97 | 1.34 | 1.53 | 1.16–1.6 | 0.95 | 1 (1) | 8815 | 0 |
| shell.workspace-structure | 300 | 15 | 16.58 | 17.89 | 16.55–17.15 | 15.73 | 9 (9) | 760917 | 0 |
| board.project-large | 300 | 18.14 | 20.83 | 23.48 | 19.27–25.25 | 20.21 | 15 (15) | 416635 | 0 |
| board.project-large.pat | 300 | 18.12 | 20.03 | 22.21 | 19.91–22.95 | 19.46 | 17 (17) | 416635 | 0 |
| board.project-medium | 300 | 10.18 | 11.54 | 13.08 | 10.79–13.06 | 10.94 | 15 (15) | 406480 | 0 |
| board.project-small | 300 | 7.24 | 8.81 | 9.43 | 8.12–10.61 | 8.18 | 15 (15) | 234966 | 0 |
| board.team | 300 | 14.2 | 16.49 | 17.99 | 15.65–16.53 | 15.89 | 10 (10) | 412139 | 0 |
| board.all | 300 | 56.95 | 69.44 | 71.18 | 59.94–123.81 | 68.89 | 10 (10) | 454478 | 0 |
| board.my-issues | 300 | 12.44 | 16.6 | 17.53 | 12.63–19.03 | 15.76 | 10 (10) | 441178 | 0 |
| board.deep-page | 300 | 18.79 | 22.52 | 25.33 | 18.81–23.18 | 21.99 | 15 (15) | 101190 | 0 |
| board.archived | 300 | 21.15 | 24.44 | 26.62 | 21.7–24.61 | 23.75 | 9 (13) | 148911 | 0 |
| task.get | 300 | 1.3 | 1.94 | 2.2 | 1.62–2.77 | 1.64 | 13 (17) | 2157 | 0 |
| task.comments | 300 | 0.97 | 1.67 | 2.41 | 1.36–2.3 | 1.31 | 9 (13) | 1579 | 0 |
| task.patch | 300 | 2.31 | 3.45 | 3.72 | 2.92–4.56 | 2.83 | 18.01 (22) | 2157 | 0 |
| search.common | 180 | 38.26 | 42.56 | 44.8 | 40.33–45.14 | 42.11 | 3.27 (7) | 1559 | 0 |
| search.rare | 180 | 90.43 | 98.17 | 107.25 | 91.5–113.67 | 97.74 | 3.4 (7) | 1065 | 0 |
| search.identifier | 180 | 90.5 | 96.86 | 100.6 | 96.6–98.24 | 96.43 | 3 (3) | 1030 | 0 |
| search.no-match | 180 | 91.07 | 99.46 | 106.81 | 93.14–152.19 | 99.04 | 3 (3) | 37 | 0 |
| inbox.list | 300 | 35.25 | 37.99 | 41.48 | 35.66–49.31 | 37.4 | 7 (7) | 113426 | 0 |
| inbox.count | 300 | 19.56 | 25.77 | 28.93 | 20.96–27.66 | 25.31 | 2 (2) | 29 | 0 |
| notifications.page | 300 | 5.24 | 24.55 | 27.1 | 23.82–27.78 | 24.24 | 5 (9) | 47098 | 0 |
| notifications.badge | 300 | 4.77 | 23.44 | 26.29 | 22.94–25.39 | 23.19 | 5 (9) | 545 | 0 |
| dashboard.tasks | 300 | 19.43 | 21.37 | 23.11 | 20.03–24.41 | 20.94 | 6.04 (10) | 191 | 0 |
| dashboard.projects | 300 | 7.12 | 8.2 | 9.39 | 7.65–9.37 | 7.85 | 4 (8) | 4458 | 0 |
| usage.summary | 300 | 38.66 | 43.68 | 46.31 | 42.55–86.69 | 43.29 | 3.44 (7) | 1855 | 0 |
| usage.by-task | 300 | 53.65 | 62.01 | 64.81 | 60.09–63.21 | 61.55 | 4 (4) | 8757 | 0 |
| usage.mcp | 300 | 0.53 | 10.16 | 11.15 | 10–11.91 | 9.92 | 4 (4) | 1036 | 0 |
| activity.feed | 300 | 171.14 | 209.93 | 243.4 | 182.02–213.28 | 209.36 | 4.12 (8) | 21778 | 0 |
| activity.project | 300 | 4.4 | 5.34 | 5.48 | 4.95–5.84 | 4.97 | 9.07 (13) | 22693 | 0 |
| bulk.status-100 | 60 | 56.25 | 73.94 | 86.35 | 68.62–84.67 | 72.55 | 128.15 (136) | 190386 | 0 |
| bulk.fanout-100 | 15 | 196.76 | 216.33 | 216.33 | 192.63–348.91 | — | 3414.8 per move | 189006 | 0 |
| chat.stream | 60 | 4.31 | 5.04 | 5.66 | 4.89–6.47 | 4.89 | 9 (12) | 688 | 0 |
| concurrent8.board-large | 480 | 58.71 | 68.64 | 73.46 | 64.48–74.24 | 64.74 | 15.03 (19) | 416635 | 0 |
| concurrent8.inbox-count | 480 | 23.19 | 25.52 | 26.7 | 23.8–27.23 | 24.51 | 2 (2) | 29 | 0 |

Chat stream (fake provider): headers p95 1.44 ms, first SSE event p95 2.18 ms, first assistant delta p95 4.39 ms, full turn p95 5.04 ms.

Fan-out: one 100-task move = 100 PATCH requests (6 in flight); per-request client p95 15.5 ms, server p95 14.2 ms; 3414.8 queries per move.

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 455b29d81016 | 111 | 102.1 | 213.77 | /api/activity |
| f4dffbe6cdde | 45 | 112.39 | 275.12 | /api/search |
| cb0f74d1992d | 20 | 114.9 | 265.43 | /api/activity |
| ecb608707d1f | 2 | 107.13 | 111.75 | /api/tasks |
| 9f94ff76072a | 1 | 123.9 | 123.9 | /api/usage/summary |

