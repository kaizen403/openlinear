# API benchmark: overhead-sample-1

Generated 2026-10-25T08:24:28.659Z by `scripts/perf/bench.ts`. Raw data: `bench-overhead-sample-1.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 3.34, max 3.4. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 600 | 0.5 | 0.73 | 1.4 | 0.65–1.21 | 0.5 | 2 (8) | 307 | 0 |
| board.project-large | 600 | 16.63 | 19.02 | 20.79 | 18.29–19.84 | 18.41 | 15 (15) | 416635 | 0 |
| board.project-large.pat | 600 | 17.16 | 19.92 | 21.41 | 18.36–19.92 | 19.04 | 17 (17) | 416635 | 0 |
| task.get | 600 | 1.13 | 1.69 | 2.14 | 1.61–2.24 | 1.51 | 13 (17) | 2157 | 0 |
| inbox.count | 600 | 18.44 | 21.26 | 24.01 | 19.57–22 | 20.78 | 2 (2) | 29 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|

