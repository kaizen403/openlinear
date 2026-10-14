#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Run in an isolated child: do not inherit credentials or relax the caller's git policy. */
export function runBenchmark(defaultArgs = []) {
  const args = [...defaultArgs, ...process.argv.slice(2)];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--output' && args[index + 1]) {
      args[index + 1] = resolve(process.cwd(), args[index + 1]);
      index += 1;
    }
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const env = {
    NODE_ENV: 'test',
    OPENLINEAR_ALLOW_FILE_GIT: '1',
    LOG_LEVEL: 'silent',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    TZ: 'UTC',
  };
  for (const key of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(scriptDir, 'latency-bench.ts'), ...args], {
    cwd: resolve(scriptDir, '..'),
    env,
    stdio: 'inherit',
  });
  const onInterrupt = () => child.kill('SIGINT');
  const onTerminate = () => child.kill('SIGTERM');
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  child.once('error', (error) => {
    console.error(JSON.stringify({ benchmark: 'openlinear-execution-offline', error: error.message }));
    process.exitCode = 1;
  });
  child.once('close', (code, signal) => {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runBenchmark();
