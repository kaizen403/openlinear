# API benchmark: overhead-prod-1

Generated 2026-10-25T08:23:37.889Z by `scripts/perf/bench.ts`. Raw data: `bench-overhead-prod-1.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 3.82, max 3.97. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 600 | 0.58 | 1.39 | 1.88 | 0.65–1.45 | 0 | 0 (0) | 307 | 0 |
| board.project-large | 600 | 17.1 | 20.61 | 22.07 | 18.44–20.63 | 0 | 0 (0) | 416635 | 0 |
| board.project-large.pat | 600 | 16.52 | 18.25 | 19.31 | 18.18–18.97 | 0 | 0 (0) | 416635 | 0 |
| task.get | 600 | 1.16 | 1.71 | 2.1 | 1.63–1.79 | 0 | 0 (0) | 2157 | 0 |
| inbox.count | 600 | 18.64 | 21.74 | 24.27 | 21.53–22.69 | 0 | 0 (0) | 29 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|

