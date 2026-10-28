// FAKE native CLI used by the eval harness (offline smoke / tests only).
// Usage: node replay-cli.mjs <recording.json>
// Prints the recorded stdout protocol of a vendor CLI (Claude Code stream-json,
// Codex JSONL or OpenCode JSON), applies the recorded file effects to the
// current directory at the recorded points, and exits with the recorded code.
// It never contacts a model or the network. This file is static so no test
// ever executes a freshly written executable.
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

const recordingPath = process.argv[2];
if (!recordingPath) {
  process.stderr.write('replay-cli: missing recording path\n');
  process.exit(64);
}
const recording = JSON.parse(readFileSync(recordingPath, 'utf8'));
const steps = recording?.native?.steps ?? [];
const effects = recording?.effects ?? [];
const root = realpathSync(process.cwd());
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

process.stdin.resume();
process.stdin.on('data', () => undefined);
process.stdin.on('error', () => undefined);
process.stderr.write('openlinear-eval replay-cli: recorded trajectory, no model contacted\n');

function applyEffect(effect) {
  const target = resolve(root, effect.path);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel.startsWith(sep) || rel.split(sep).includes('.git')) {
    throw new Error(`effect escapes the worktree: ${effect.path}`);
  }
  if (effect.op === 'delete') {
    rmSync(target, { force: true });
    return;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, effect.content ?? '');
}

for (const step of steps) {
  if ('line' in step) process.stdout.write(`${JSON.stringify(step.line)}\n`);
  else if ('sleepMs' in step) await sleep(step.sleepMs);
  else if ('stderr' in step) process.stderr.write(`${step.stderr}\n`);
  else if ('effect' in step) {
    const effect = effects[step.effect];
    if (effect) applyEffect(effect);
  } else if ('hang' in step) await new Promise(() => setInterval(() => undefined, 1 << 30));
  else if ('exit' in step) {
    process.stdout.write('', () => process.exit(step.exit));
    await new Promise(() => undefined);
  }
}
process.stdout.write('', () => process.exit(0));
