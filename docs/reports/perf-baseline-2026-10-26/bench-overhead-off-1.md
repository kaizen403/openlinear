# API benchmark: overhead-off-1

Generated 2026-10-25T08:22:46.792Z by `scripts/perf/bench.ts`. Raw data: `bench-overhead-off-1.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 4.12, max 4.36. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 600 | 0.79 | 1.17 | 1.39 | 0.71–1.61 | 0 | 0 (0) | 307 | 0 |
| board.project-large | 600 | 16.86 | 19.63 | 22.34 | 18.74–20.17 | 0 | 0 (0) | 416635 | 0 |
| board.project-large.pat | 600 | 16.97 | 19.24 | 20.28 | 18.31–22.07 | 0 | 0 (0) | 416635 | 0 |
| task.get | 600 | 1.2 | 1.98 | 2.55 | 1.6–2.13 | 0 | 0 (0) | 2157 | 0 |
| inbox.count | 600 | 18.81 | 21.78 | 23.76 | 20.31–22.43 | 0 | 0 (0) | 29 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|

