import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { FakeAgentRunner, type AgentEvent, type AgentRunner } from '@openlinear/execution-core';
import { RunCoordinator } from '../src/engine/run-coordinator';
import { SessionManager } from '../src/engine/session-manager';
import { RunJournal, type JournalAppendResult } from '../src/journal/sqlite';
import { acquireLocalWorktree, releaseLocalWorktree, type WorkspaceHandle } from '../src/workspace/local-worktree';

interface Options {
  fixtureBytes: number;
  seed: number;
  coldIterations: number;
  warmIterations: number;
  output?: string;
  maxWarmP95Ms?: number;
}

const phaseNames = [
  'journalOpenMs', 'workspaceAcquireMs', 'executionToFirstDeltaMs',
  'coordinatorToFirstDeltaMs', 'coordinatorCompleteMs', 'journalVerifyMs',
  'workspaceReleaseMs', 'totalMs',
] as const;
type Phase = typeof phaseNames[number];
type Mode = 'cold' | 'warm' | 'warmup';
interface Sample {
  mode: Mode;
  iteration: number;
  success: boolean;
  phasesMs: Partial<Record<Phase, number>>;
  eventCount?: number;
  error?: string;
}

const help = `Offline OpenLinear execution microbenchmark (Node 22.13+ and git required).
Usage: node apps/sidecar/scripts/latency-bench.mjs [options]
  --fixture-bytes N       Seeded tracked payload bytes (default 2000000)
  --seed N                Unsigned 32-bit nonzero seed (default 403)
  --cold-iterations N     Independent empty-mirror trials (default 3)
  --warm-iterations N     Reused-mirror trials after one warmup (default 10)
  --output PATH           Also save the complete JSON report
  --max-warm-p95-ms N     Gate warm executionToFirstDeltaMs (opt-in)
  --help                  Print this help
Cold means empty application mirror; OS page cache is not flushed.
No model, remote network, sandbox service, API, or PR creation is measured.`;

function parseOptions(): Options | null {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log(help); return null; }
  const options: Options = { fixtureBytes: 2_000_000, seed: 403, coldIterations: 3, warmIterations: 10 };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--output') { options.output = resolve(value); continue; }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error(`${flag} must be positive and finite`);
    if (flag === '--max-warm-p95-ms') { options.maxWarmP95Ms = number; continue; }
    if (!Number.isSafeInteger(number)) throw new Error(`${flag} must be an integer`);
    if (flag === '--fixture-bytes') options.fixtureBytes = number;
    else if (flag === '--seed' && number <= 0xffff_ffff) options.seed = number;
    else if (flag === '--cold-iterations' && number <= 1000) options.coldIterations = number;
    else if (flag === '--warm-iterations' && number <= 1000) options.warmIterations = number;
    else throw new Error(`Unknown option or out-of-range value: ${flag}`);
  }
  return options;
}

const execFileAsync = promisify(execFile);
const interrupted = new AbortController();
function checkInterrupted(): void {
  if (interrupted.signal.aborted) throw new Error('Benchmark interrupted');
}
async function git(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const result = await execFileAsync('git', [
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', ...args,
  ], { cwd, env: { ...process.env, ...env }, timeout: 120_000, signal: interrupted.signal, maxBuffer: 4 * 1024 * 1024 });
  return result.stdout.trim();
}

function createFixture(directory: string, options: Options): { bytes: number; files: number; sha256: string } {
  mkdirSync(directory, { recursive: true });
  let state = options.seed;
  let remaining = options.fixtureBytes;
  let files = 0;
  const hash = createHash('sha256');
  while (remaining > 0) {
    checkInterrupted();
    const buffer = Buffer.alloc(Math.min(256 * 1024, remaining));
    for (let offset = 0; offset < buffer.length; offset += 4) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const word = state >>> 0;
      for (let byte = 0; byte < Math.min(4, buffer.length - offset); byte += 1) {
        buffer[offset + byte] = (word >>> (byte * 8)) & 0xff;
      }
    }
    const name = `payload-${String(files).padStart(6, '0')}.bin`;
    writeFileSync(join(directory, name), buffer);
    hash.update(buffer);
    remaining -= buffer.length;
    files += 1;
  }
  const bytes = readdirSync(directory).reduce((sum, name) => sum + statSync(join(directory, name)).size, 0);
  if (bytes !== options.fixtureBytes) throw new Error('Fixture byte count mismatch');
  return { bytes, files, sha256: hash.digest('hex') };
}

class MeasuredJournal extends RunJournal {
  firstDeltaAt: number | undefined;
  override append(runId: string, event: AgentEvent): JournalAppendResult {
    const result = super.append(runId, event);
    // Observe only after the real SQLite append, including its heartbeat write.
    if (event.t === 'message.delta' && this.firstDeltaAt === undefined) this.firstDeltaAt = performance.now();
    return result;
  }
}

const script: AgentEvent[] = [
  { t: 'turn.started', turn: 1 },
  { t: 'message.delta', text: 'offline fixture response' },
  { t: 'tool.started', callId: 'fixture-tool', name: 'fixture', input: { offline: true } },
  { t: 'tool.output', callId: 'fixture-tool', chunk: 'scripted fixture output' },
  { t: 'tool.finished', callId: 'fixture-tool', name: 'fixture', ok: true },
  { t: 'usage', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 } },
  { t: 'turn.finished', turn: 1, reason: 'idle' },
];

async function measure(input: {
  root: string; cloneUrl: string; appData: string; mode: Mode; iteration: number; fixtureBytes: number;
}): Promise<Sample> {
  process.env.OPENLINEAR_APP_DATA = input.appData;
  const sample: Sample = { mode: input.mode, iteration: input.iteration, success: false, phasesMs: {} };
  const startedAt = performance.now();
  const runId = `bench-${input.mode}-${input.iteration}`;
  const journalPath = join(input.root, 'journals', `${runId}.sqlite`);
  let journal: MeasuredJournal | undefined;
  let workspace: WorkspaceHandle | undefined;
  try {
    const journalStart = performance.now();
    journal = new MeasuredJournal(journalPath);
    sample.phasesMs.journalOpenMs = performance.now() - journalStart;
    const acquireStart = performance.now();
    workspace = await acquireLocalWorktree({
      owner: 'benchmark', name: 'fixture', cloneUrl: input.cloneUrl,
      baseRef: 'main', runId, accessToken: null,
    });
    sample.phasesMs.workspaceAcquireMs = performance.now() - acquireStart;
    checkInterrupted();
    const checkoutPath = workspace.worktreePath;
    const checkedOutBytes = readdirSync(checkoutPath)
      .filter((name) => name.startsWith('payload-'))
      .reduce((sum, name) => sum + statSync(join(checkoutPath, name)).size, 0);
    if (checkedOutBytes !== input.fixtureBytes) throw new Error('Worktree payload byte count mismatch');

    const runner = new FakeAgentRunner();
    runner.setScript(runId, { events: script });
    const coordinator = new RunCoordinator(journal, new SessionManager(journal), new Map<string, AgentRunner>([['opencode', runner]]));
    let completed = false;
    let completionError: string | undefined;
    const coordinatorStart = performance.now();
    await coordinator.start({
      runId, taskId: runId, runnerId: 'opencode', worktreePath: workspace.worktreePath,
      prompt: 'Offline latency fixture: consume scripted events; do not access external services.',
      onComplete: async (ok, error) => { completed = ok; completionError = error; },
    });
    sample.phasesMs.coordinatorCompleteMs = performance.now() - coordinatorStart;
    checkInterrupted();
    if (!completed || journal.getRun(runId)?.status !== 'succeeded') {
      throw new Error(completionError ?? 'Coordinator did not persist successful completion');
    }
    if (journal.firstDeltaAt === undefined) throw new Error('No journaled message delta observed');
    sample.phasesMs.executionToFirstDeltaMs = journal.firstDeltaAt - startedAt;
    sample.phasesMs.coordinatorToFirstDeltaMs = journal.firstDeltaAt - coordinatorStart;

    const verifyStart = performance.now();
    journal.close();
    journal = undefined;
    const persisted = new RunJournal(journalPath);
    try {
      if (persisted.getRun(runId)?.status !== 'succeeded') throw new Error('Reopened journal lost completion');
      // Public API checks that all native events survived close/reopen and sequence continues.
      const verification = persisted.append(runId, { t: 'heartbeat' });
      sample.eventCount = verification.seq;
      if (verification.seq !== script.length + 2) throw new Error('Persisted journal event sequence mismatch');
    } finally { persisted.close(); }
    sample.phasesMs.journalVerifyMs = performance.now() - verifyStart;
    const releaseStart = performance.now();
    await releaseLocalWorktree(workspace);
    if (existsSync(workspace.worktreePath)) throw new Error('Worktree release left checkout behind');
    workspace = undefined;
    sample.phasesMs.workspaceReleaseMs = performance.now() - releaseStart;
    sample.success = true;
  } catch (error) {
    sample.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (journal) journal.close();
    if (workspace) await releaseLocalWorktree(workspace);
    sample.phasesMs.totalMs = performance.now() - startedAt;
  }
  return sample;
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}
function summarize(samples: Sample[], mode: 'cold' | 'warm') {
  const selected = samples.filter((sample) => sample.mode === mode);
  const success = selected.filter((sample) => sample.success);
  const phases = Object.fromEntries(phaseNames.map((phase) => {
    const values = success.map((sample) => sample.phasesMs[phase]).filter((value): value is number => value !== undefined);
    return [phase, values.length ? {
      samples: values.length, p50: percentile(values, 0.50), p95: percentile(values, 0.95), p99: percentile(values, 0.99),
    } : null];
  }));
  return { attempts: selected.length, successCount: success.length, errorCount: selected.length - success.length, phasesMs: phases };
}

async function main(options: Options): Promise<void> {
  if (process.env.NODE_ENV !== 'test' || process.env.OPENLINEAR_ALLOW_FILE_GIT !== '1') {
    throw new Error('Run the .mjs wrapper to isolate benchmark-only local git permissions');
  }
  const root = mkdtempSync(join(tmpdir(), 'openlinear-latency-'));
  const samples: Sample[] = [];
  const errors: string[] = [];
  let fixture: ReturnType<typeof createFixture> | undefined;
  let fixtureCommit: string | undefined;
  let gitVersion: string | undefined;
  const setupStart = performance.now();
  let setupMs: number | undefined;
  const onSignal = () => interrupted.abort();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const origin = join(root, 'origin');
    fixture = createFixture(origin, options);
    gitVersion = await git(['--version'], root);
    await git(['init', '--initial-branch=main', origin], root);
    // The controlled file:// origin should support the same partial-clone mechanism as GitHub.
    await git(['config', 'uploadpack.allowFilter', 'true'], origin);
    await git(['config', 'uploadpack.allowAnySHA1InWant', 'true'], origin);
    await git(['add', '--all'], origin);
    await git(['-c', 'user.name=OpenLinear Benchmark', '-c', 'user.email=benchmark@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'Deterministic offline benchmark fixture'], origin,
    { GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' });
    fixtureCommit = await git(['rev-parse', 'HEAD'], origin);
    setupMs = performance.now() - setupStart;
    const cloneUrl = pathToFileURL(origin).href;
    for (let iteration = 0; iteration < options.coldIterations; iteration += 1) {
      checkInterrupted();
      const appData = join(root, `cold-${iteration}`);
      samples.push(await measure({ root, cloneUrl, appData, mode: 'cold', iteration, fixtureBytes: fixture.bytes }));
      rmSync(appData, { recursive: true, force: true });
    }
    const appData = join(root, 'warm');
    samples.push(await measure({ root, cloneUrl, appData, mode: 'warmup', iteration: 0, fixtureBytes: fixture.bytes }));
    if (!samples.at(-1)?.success) throw new Error('Warmup failed; warm measurements are invalid');
    for (let iteration = 0; iteration < options.warmIterations; iteration += 1) {
      checkInterrupted();
      samples.push(await measure({ root, cloneUrl, appData, mode: 'warm', iteration, fixtureBytes: fixture.bytes }));
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    delete process.env.OPENLINEAR_APP_DATA;
    try { rmSync(root, { recursive: true, force: true }); }
    catch (error) { errors.push(`Temporary fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`); }
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  const cold = summarize(samples, 'cold');
  const warm = summarize(samples, 'warm');
  const warmFirstDelta = warm.phasesMs.executionToFirstDeltaMs;
  const gatePassed = options.maxWarmP95Ms === undefined ? null
    : warmFirstDelta !== null && warmFirstDelta.p95 <= options.maxWarmP95Ms;
  const failed = errors.length > 0 || samples.some((sample) => !sample.success)
    || cold.attempts !== options.coldIterations || warm.attempts !== options.warmIterations || gatePassed === false;
  const report = {
    schemaVersion: 1,
    name: 'openlinear-execution-offline',
    generatedAt: new Date().toISOString(),
    success: !failed,
    scope: 'Local git worktree + SQLite journal + RunCoordinator/SessionManager + FakeAgentRunner only',
    exclusions: ['model inference', 'remote network', 'cloud sandbox provisioning', 'API/SSE transport', 'real edits/tests', 'PR publication'],
    interpretation: 'Descriptive microbenchmark; does not establish task-to-PR latency or Terminal-Bench superiority.',
    percentileMethod: 'nearest-rank over successful trials; failures remain explicit and fail the benchmark; small sample tails are descriptive',
    cachePolicy: 'cold: empty application mirror each trial; warm: reuse mirror after one excluded warmup; OS page cache is not flushed',
    phases: {
      executionToFirstDeltaMs: 'Start of measured iteration through first message.delta persisted in SQLite (includes checkout byte-count validation)',
      coordinatorToFirstDeltaMs: 'Coordinator start through first message.delta persisted in SQLite',
      coordinatorCompleteMs: 'Full coordinator event consumption and persisted completion; overlaps first-delta phases',
      totalMs: 'Journal open, worktree acquisition, fixture validation, coordinator, journal reopen/verification, and worktree release',
    },
    hardware: { platform: platform(), release: release(), architecture: arch(), cpuModel: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    runtime: { node: process.version, sqlite: process.versions.sqlite, git: gitVersion },
    sourceSha256: Object.fromEntries([
      './latency-bench.mjs', './latency-bench.ts', '../src/workspace/local-worktree.ts',
      '../src/engine/run-coordinator.ts', '../src/engine/session-manager.ts', '../src/journal/sqlite.ts',
      '../src/services/git-credentials.ts', '../src/engine/system-contract.ts',
      '../../../packages/execution-core/src/fake-runner.ts',
    ].map((path) => [path, createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')])),
    config: options,
    fixture: fixture ? {
      ...fixture, seed: options.seed, trackedCommit: fixtureCommit,
      generator: 'xorshift32 little-endian words; sequential 256 KiB payload files',
      cloneTransport: 'local file:// upload-pack with partial-clone filtering enabled',
    } : null,
    setupMs,
    successCount: samples.filter((sample) => sample.mode !== 'warmup' && sample.success).length,
    attemptedCount: samples.filter((sample) => sample.mode !== 'warmup').length,
    summary: { cold, warm },
    gate: { phase: 'executionToFirstDeltaMs', maxWarmP95Ms: options.maxWarmP95Ms ?? null, passed: gatePassed },
    samples,
    errors,
    temporaryFixtureCleaned: !existsSync(root),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, json);
  }
  process.stdout.write(json);
  if (failed) process.exitCode = interrupted.signal.aborted ? 130 : 1;
}

try {
  const options = parseOptions();
  if (options) await main(options);
} catch (error) {
  console.error(JSON.stringify({ benchmark: 'openlinear-execution-offline', error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
}
