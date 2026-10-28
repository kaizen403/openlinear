# API benchmark: baseline

Generated 2026-10-25T08:33:10.845Z by `scripts/perf/bench.ts`. Raw data: `bench-baseline.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 4.82, max 6.07. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.55 | 0.91 | 1.53 | 0.63–1.63 | 0.66 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 0.91 | 1.44 | 1.63 | 1.04–2.17 | 1.07 | 6 (6) | 654 | 0 |
| shell.projects.ui-fields | 300 | 3.3 | 4.25 | 4.81 | 3.81–5.41 | 3.49 | 2 (2) | 70141 | 0 |
| shell.projects.default | 300 | 4.12 | 5.17 | 5.63 | 5.05–6.72 | 4.62 | 5 (5) | 107644 | 0 |
| shell.teams.ui-fields | 300 | 0.68 | 1 | 1.4 | 1–1.1 | 0.73 | 1 (1) | 8815 | 0 |
| shell.workspace-structure | 300 | 13.73 | 16.6 | 18.23 | 15.62–16.8 | 15.9 | 9 (9) | 760917 | 0 |
| board.project-large | 300 | 16.39 | 19.82 | 24.93 | 18.82–20.64 | 18.81 | 15 (15) | 416635 | 0 |
| board.project-large.pat | 300 | 16.2 | 18.13 | 20.24 | 17.06–19.87 | 17.65 | 17 (17) | 416635 | 0 |
| board.project-medium | 300 | 8.68 | 10.69 | 11.11 | 10.03–11.59 | 10.2 | 15 (15) | 406480 | 0 |
| board.project-small | 300 | 6.21 | 7.65 | 8.61 | 7.59–9.11 | 7.27 | 15 (15) | 234966 | 0 |
| board.team | 300 | 12.83 | 15.55 | 17.46 | 13.34–18.44 | 14.95 | 10 (10) | 412139 | 0 |
| board.all | 300 | 54.55 | 59.19 | 62.18 | 56.55–62.63 | 58.42 | 10 (10) | 454478 | 0 |
| board.my-issues | 300 | 10.28 | 11.86 | 13.2 | 11.37–12.03 | 11.38 | 10 (10) | 441178 | 0 |
| board.deep-page | 300 | 16.44 | 19.38 | 20.95 | 18.75–19.75 | 18.91 | 15 (15) | 101190 | 0 |
| board.archived | 300 | 15.62 | 16.76 | 17.71 | 16.66–23.27 | 16.37 | 9 (9) | 148911 | 0 |
| task.get | 300 | 1.1 | 1.54 | 1.86 | 1.46–1.66 | 1.37 | 13 (13) | 2157 | 0 |
| task.comments | 300 | 0.85 | 1.18 | 1.42 | 1.15–1.26 | 0.99 | 9 (9) | 1579 | 0 |
| task.patch | 300 | 1.79 | 2.32 | 3.41 | 2.12–2.98 | 2.08 | 18 (18) | 2157 | 0 |
| search.common | 180 | 37.36 | 40.24 | 42.01 | 40.14–40.62 | 39.89 | 3 (3) | 1559 | 0 |
| search.rare | 180 | 87.92 | 94.74 | 101.97 | 91.95–98.61 | 94.33 | 3.6 (7) | 1065 | 0 |
| search.identifier | 180 | 89.05 | 97.06 | 100.61 | 95.41–100.31 | 96.64 | 3.2 (7) | 1030 | 0 |
| search.no-match | 180 | 90.66 | 94.3 | 97.44 | 94.04–198.67 | 93.85 | 3 (3) | 37 | 0 |
| inbox.list | 300 | 32.95 | 38.06 | 40.02 | 36.66–42.45 | 37.48 | 7 (7) | 113426 | 0 |
| inbox.count | 300 | 18.07 | 20.36 | 21.49 | 17.16–25.33 | 19.87 | 2 (2) | 29 | 0 |
| notifications.page | 300 | 5.59 | 21.47 | 25.89 | 20.76–26.62 | 21.17 | 5 (5) | 47098 | 0 |
| notifications.page.owner | 300 | 24.33 | 29.87 | 33.57 | 26.55–30.73 | 29.46 | 5 (5) | 47500 | 0 |
| notifications.badge | 300 | 4.39 | 22.09 | 25.67 | 19.59–24.77 | 21.79 | 5 (5) | 545 | 0 |
| dashboard.tasks | 300 | 19.59 | 22.16 | 23.93 | 19.73–22.68 | 21.71 | 6 (6) | 191 | 0 |
| dashboard.projects | 300 | 7.2 | 8.32 | 8.75 | 7.01–11.73 | 7.95 | 4 (4) | 4458 | 0 |
| usage.summary | 300 | 38.28 | 43.06 | 45.07 | 38.48–47.12 | 42.7 | 3.64 (7) | 1855 | 0 |
| usage.by-task | 300 | 52.69 | 61.93 | 66.47 | 54.24–64.2 | 61.56 | 4 (8) | 8757 | 0 |
| usage.mcp | 300 | 0.46 | 9.77 | 10.41 | 9.46–10.26 | 9.58 | 4 (4) | 1036 | 0 |
| usage.mcp.owner | 300 | 10.08 | 11.25 | 13.25 | 11.2–11.45 | 10.3 | 4 (4) | 1342 | 0 |
| activity.feed | 300 | 166.83 | 184.75 | 191.69 | 178.89–210.27 | 184.24 | 4 (4) | 21778 | 0 |
| activity.project | 300 | 4.04 | 5.2 | 6.1 | 4.91–6.55 | 4.97 | 9 (13) | 22693 | 0 |
| bulk.status-100 | 60 | 55.53 | 65.05 | 72.57 | 59.36–72.43 | 60.81 | 126.9 (141) | 190386 | 0 |
| bulk.fanout-100 | 15 | 216.6 | 238.36 | 238.36 | 227.31–243.53 | — | 3416.4 per move | 189006 | 0 |
| chat.stream | 60 | 3.75 | 4.52 | 5 | 4.41–5.64 | 4.36 | 8.6 (12) | 688 | 0 |
| concurrent8.board-large | 480 | 47.94 | 56.69 | 64.39 | 55.76–61.92 | 53.83 | 15.05 (19) | 416635 | 0 |
| concurrent8.inbox-count | 480 | 20.67 | 24.06 | 25.19 | 23.03–24.52 | 23.42 | 2 (2) | 29 | 0 |

Chat stream (fake provider): headers p95 1.06 ms, first SSE event p95 1.99 ms, first assistant delta p95 4.04 ms, full turn p95 4.52 ms.

Fan-out: one 100-task move = 100 PATCH requests (6 in flight); per-request client p95 17.47 ms, server p95 16.43 ms; 3416.4 queries per move.

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 455b29d81016 | 45 | 101.81 | 113.68 | /api/activity |
| f4dffbe6cdde | 30 | 114.35 | 221 | /api/search |
| cb0f74d1992d | 8 | 108.47 | 125.68 | /api/activity |

