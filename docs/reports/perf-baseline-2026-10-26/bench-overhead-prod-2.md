# API benchmark: overhead-prod-2

Generated 2026-10-25T08:26:14.218Z by `scripts/perf/bench.ts`. Raw data: `bench-overhead-prod-2.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 4.27, max 4.71. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 600 | 0.68 | 1.4 | 1.62 | 0.88–2.59 | 0 | 0 (0) | 307 | 0 |
| board.project-large | 600 | 17.6 | 19.34 | 20.92 | 19.3–20.62 | 0 | 0 (0) | 416635 | 0 |
| board.project-large.pat | 600 | 17.96 | 20.67 | 24.41 | 20.31–21.66 | 0 | 0 (0) | 416635 | 0 |
| task.get | 600 | 1.54 | 2.28 | 2.7 | 1.88–2.67 | 0 | 0 (0) | 2157 | 0 |
| inbox.count | 600 | 19.75 | 22.31 | 25.36 | 21.94–24.52 | 0 | 0 (0) | 29 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|

