#!/usr/bin/env node
import { runBenchmark } from './latency-bench.mjs';

// Explicit opt-in for a 300 MiB fixture. Thresholds require a calibrated machine baseline.
runBenchmark(['--fixture-bytes', String(300 * 1024 * 1024), '--cold-iterations', '1', '--warm-iterations', '5']);
