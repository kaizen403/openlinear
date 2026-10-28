# API benchmark: overhead-sample-2

Generated 2026-10-25T08:27:07.252Z by `scripts/perf/bench.ts`. Raw data: `bench-overhead-sample-2.json`.

Host: Apple M5 Pro, 15 cores, 24 GiB, darwin 27.0.0; Node v22.16.0; PostgreSQL 14.17 (Homebrew) on aarch64-apple-darwin24.2.0.
Load (1-min avg) sampled every 5 s during the run: mean 5.31, max 6. Other engineers' test suites were running on the same machine.
Fixture: 50000 tasks (large project 7975, medium 797, small 131), 336648 activity rows, 102683 comments.
Rounds: 3; values are the median across rounds; "p95 spread" is min..max of the per-round p95. Latency is client-side on loopback; "server" is the API's own route-timing duration.

| Scenario | n | p50 ms | p95 ms | p99 ms | p95 spread | server p95 | queries/req (max) | mean bytes | errors |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|
| shell.me | 600 | 0.5 | 0.81 | 1.41 | 0.76–1.53 | 0.55 | 2 (8) | 307 | 0 |
| board.project-large | 600 | 17.12 | 19.52 | 23.91 | 18.74–19.77 | 19.06 | 15 (15) | 416635 | 0 |
| board.project-large.pat | 600 | 17.49 | 26.03 | 29.59 | 18.13–31.26 | 25.13 | 17 (17) | 416635 | 0 |
| task.get | 600 | 1.74 | 2.56 | 2.93 | 2.04–3.17 | 2.15 | 13 (17) | 2157 | 0 |
| inbox.count | 600 | 19.48 | 23.7 | 28.21 | 22.59–25.11 | 23.14 | 2 (2) | 29 | 0 |

## Slowest statements (server log, threshold 100 ms)

| fingerprint | count | p50 ms | max ms | routes |
|---|---:|---:|---:|---|

