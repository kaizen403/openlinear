# API benchmark: with-phase0-indexes

Generated 2026-10-25T08:39:27.708Z by `scripts/perf/bench.ts`. Raw data: `bench-with-phase0-indexes.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 5.29, max 9.36. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 300 | 0.76 | 1.49 | 1.79 | 0.62–1.64 | 1.06 | 2 (8) | 307 | 0 |
| shell.workspaces | 300 | 1.37 | 1.65 | 2.07 | 1–2.25 | 1.37 | 6 (6) | 654 | 0 |
| shell.projects.ui-fields | 300 | 3.13 | 4.21 | 5.06 | 4.05–4.68 | 3.92 | 2 (2) | 70141 | 0 |
| shell.projects.default | 300 | 4.06 | 4.91 | 5.26 | 4.72–5.7 | 4.37 | 5 (5) | 107644 | 0 |
| shell.teams.ui-fields | 300 | 0.71 | 1 | 1.24 | 0.86–1.46 | 0.66 | 1 (1) | 8815 | 0 |
| shell.workspace-structure | 300 | 13.5 | 15.94 | 16.87 | 14.98–17.15 | 15.32 | 9 (9) | 760917 | 0 |
| board.project-large | 300 | 17.58 | 19.84 | 20.68 | 17.97–21.78 | 19.26 | 15 (15) | 416635 | 0 |
| board.project-large.pat | 300 | 16.46 | 18.48 | 20.26 | 17.73–19.37 | 18.05 | 17 (17) | 416635 | 0 |
| board.project-medium | 300 | 8.92 | 10.49 | 10.79 | 10.37–11.65 | 10.09 | 15 (15) | 406480 | 0 |
| board.project-small | 300 | 6.56 | 7.88 | 8.14 | 7.77–8.54 | 7.5 | 15 (15) | 234966 | 0 |
| board.team | 300 | 12.63 | 14.71 | 15.64 | 13.56–14.72 | 14.1 | 10 (10) | 412139 | 0 |
| board.all | 300 | 55.39 | 63.26 | 64.22 | 59.92–63.32 | 62.65 | 10 (10) | 454478 | 0 |
| board.my-issues | 300 | 11.9 | 17.4 | 18.89 | 13.41–21.96 | 16.69 | 10 (10) | 441178 | 0 |
| board.deep-page | 300 | 16.77 | 18.88 | 20.06 | 18.54–19.96 | 18.27 | 15 (15) | 101190 | 0 |
| board.archived | 300 | 16.86 | 18.7 | 20.4 | 17.39–25.01 | 18.16 | 9 (9) | 148911 | 0 |
| task.get | 300 | 1.25 | 1.98 | 2.49 | 1.89–2.54 | 1.66 | 13 (13) | 2157 | 0 |
| task.comments | 300 | 0.93 | 1.26 | 1.46 | 1.2–1.34 | 1.02 | 9 (9) | 1579 | 0 |
| task.patch | 300 | 2.08 | 2.65 | 3.12 | 2.43–3.08 | 2.43 | 18.01 (20) | 2157 | 0 |
| search.common | 180 | 38.35 | 41.16 | 44.67 | 40.28–43.47 | 40.71 | 3 (3) | 1559 | 0 |
| search.rare | 180 | 90.51 | 95.88 | 99.24 | 95.11–97.91 | 95.39 | 4.07 (7) | 1065 | 0 |
| search.identifier | 180 | 92.98 | 101.75 | 110.26 | 97.52–104.69 | 101.2 | 3 (3) | 1030 | 0 |
| search.no-match | 180 | 91.21 | 97.05 | 100.33 | 96.13–103.42 | 96.66 | 3 (3) | 37 | 0 |
| inbox.list | 300 | 34.24 | 37.69 | 41.09 | 36.8–38.47 | 37.27 | 7 (7) | 113426 | 0 |
| inbox.count | 300 | 18.3 | 20.21 | 22.17 | 19.18–25.49 | 19.73 | 2 (2) | 29 | 0 |
| notifications.page | 300 | 6.08 | 24.33 | 27.79 | 23.59–29.36 | 23.92 | 5 (5) | 47098 | 0 |
| notifications.page.owner | 300 | 24.26 | 37.44 | 43.66 | 32.82–79.47 | 36.87 | 5 (5) | 47500 | 0 |
| notifications.badge | 300 | 4.43 | 21.02 | 23.05 | 19.93–24.51 | 20.77 | 5 (5) | 545 | 0 |
| dashboard.tasks | 300 | 20 | 22.78 | 24.32 | 22.51–27.23 | 22.31 | 6 (6) | 191 | 0 |
| dashboard.projects | 300 | 4.92 | 6.37 | 6.84 | 5.57–7.16 | 5.89 | 4 (8) | 4458 | 0 |
| usage.summary | 300 | 38.06 | 46.73 | 47.81 | 46.03–53.44 | 46.19 | 3.64 (7) | 1855 | 0 |
| usage.by-task | 300 | 49.41 | 57.61 | 60.01 | 53.03–60.58 | 57.19 | 4 (4) | 8757 | 0 |
| usage.mcp | 300 | 0.49 | 9.67 | 10.25 | 9.61–9.76 | 9.45 | 4 (4) | 1036 | 0 |
| usage.mcp.owner | 300 | 9.91 | 11.47 | 14.14 | 10.95–17.6 | 10.56 | 4 (4) | 1342 | 0 |
| activity.feed | 300 | 166.04 | 177.24 | 182.86 | 176.08–256.07 | 176.77 | 4 (8) | 21778 | 0 |
| activity.project | 300 | 4.2 | 5.55 | 6.09 | 4.55–5.61 | 5.2 | 9.08 (13) | 22693 | 0 |
| bulk.status-100 | 60 | 54.04 | 63.49 | 71.5 | 59.98–68.51 | 58.7 | 128.55 (138) | 190386 | 0 |
| bulk.fanout-100 | 15 | 176.75 | 200.15 | 200.15 | 184.91–209.82 | — | 3416.4 per move | 189006 | 0 |
| chat.stream | 60 | 3.61 | 4.44 | 4.81 | 4.02–4.86 | 4.3 | 8.2 (12) | 688 | 0 |
| concurrent8.board-large | 480 | 49.27 | 63.02 | 82.24 | 61.24–68.81 | 58.47 | 15 (19) | 416635 | 0 |
| concurrent8.inbox-count | 480 | 20.3 | 24 | 24.85 | 23.91–26.44 | 23.26 | 2 (2) | 29 | 0 |

Chat stream (fake provider): headers p95 0.82 ms, first SSE event p95 1.66 ms, first assistant delta p95 3.94 ms, full turn p95 4.44 ms.

Fan-out: one 100-task move = 100 PATCH requests (6 in flight); per-request client p95 14.18 ms, server p95 13.2 ms; 3416.4 queries per move.

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|
| 455b29d81016 | 54 | 104.55 | 185.59 | /api/activity |
| f4dffbe6cdde | 17 | 102.38 | 116.74 | /api/search |
| cb0f74d1992d | 11 | 109.06 | 237.15 | /api/activity |

