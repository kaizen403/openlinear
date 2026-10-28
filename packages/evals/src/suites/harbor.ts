import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { Outcome, Termination } from '../grading/outcome';
import type { EvalManifest } from '../manifest/schema';
import { manifestDigest } from '../manifest/schema';
import { TRIAL_SCHEMA_VERSION, type TrialRecord } from '../records';
import type { UsageRecord } from '../usage/cost';
import { hashTree, sha256Hex } from '../util/hash';
import { parseToml } from '../util/toml';

/**
 * Harbor task/job formats, as used by Terminal-Bench 4.0 and SWE-bench Pro V2.
 * Sources (read 2026-10-26):
 * - Task configuration: https://docs.harborframework.com/tasks/configuration.md
 * - Verifier / reward files: https://docs.harborframework.com/tasks/verifier.md
 * - Network policies: https://docs.harborframework.com/tasks/network-policies.md
 * - Resources: https://docs.harborframework.com/tasks/resources.md
 * - `harbor run` flags: https://docs.harborframework.com/jobs/run-a-job.md and jobs/configs.md
 * - Trial output layout and result model: harbor-framework/harbor `src/harbor/models/trial/{paths,result,error_policy}.py`,
 *   `models/agent/context.py`, `models/verifier/result.py` (main, fetched 2026-10-26; Harbor v0.25.0 = fdba28fc).
 */

const NetworkMode = z.enum(['no-network', 'public', 'allowlist']);

const HarborEnvironmentSchema = z
  .object({
    build_timeout_sec: z.number().optional(),
    network_mode: NetworkMode.nullable().optional(),
    allowed_hosts: z.array(z.string()).nullable().optional(),
    docker_image: z.string().nullable().optional(),
    os: z.enum(['linux', 'windows']).optional(),
    cpus: z.number().nullable().optional(),
    memory_mb: z.number().nullable().optional(),
    storage_mb: z.number().nullable().optional(),
    gpus: z.number().nullable().optional(),
    allow_internet: z.boolean().nullable().optional(),
    workdir: z.string().nullable().optional(),
    env: z.record(z.unknown()).optional(),
    mcp_servers: z.array(z.record(z.unknown())).optional(),
  })
  .passthrough();

export const HarborTaskConfigSchema = z
  .object({
    schema_version: z.string().optional(),
    source: z.string().nullable().optional(),
    artifacts: z.array(z.union([z.string(), z.record(z.unknown())])).optional(),
    task: z
      .object({ name: z.string(), version: z.string().optional(), description: z.string().optional(), keywords: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
    metadata: z.record(z.unknown()).optional(),
    verifier: z
      .object({
        timeout_sec: z.number().optional(),
        network_mode: NetworkMode.nullable().optional(),
        allowed_hosts: z.array(z.string()).nullable().optional(),
        environment_mode: z.enum(['shared', 'separate']).nullable().optional(),
        environment: HarborEnvironmentSchema.nullable().optional(),
        env: z.record(z.unknown()).optional(),
      })
      .passthrough()
      .optional(),
    agent: z
      .object({
        timeout_sec: z.number().nullable().optional(),
        network_mode: NetworkMode.nullable().optional(),
        allowed_hosts: z.array(z.string()).nullable().optional(),
      })
      .passthrough()
      .optional(),
    environment: HarborEnvironmentSchema.optional(),
    solution: z.object({ env: z.record(z.unknown()).optional() }).passthrough().optional(),
  })
  .passthrough();

export type HarborTaskConfig = z.infer<typeof HarborTaskConfigSchema>;

export interface HarborTaskSummary {
  name: string;
  /** `# harbor-canary GUID …` on the first line, used as a contamination canary. */
  canary: string | null;
  agentTimeoutSec: number | null;
  verifierTimeoutSec: number;
  /** Effective network policy per phase (phase override, else the environment baseline, else public). */
  network: { agent: string; verifier: string; environment: string; agentAllowedHosts: string[] };
  resources: { cpus: number | null; memoryMb: number | null; storageMb: number | null };
  dockerImage: string | null;
  verifierMode: 'shared' | 'separate' | 'default';
  category: string | null;
}

export function parseHarborTaskToml(source: string): { config: HarborTaskConfig; summary: HarborTaskSummary } {
  const config = HarborTaskConfigSchema.parse(parseToml(source));
  const canaryMatch = /^#\s*harbor-canary GUID\s+([0-9a-f-]{36})/im.exec(source);
  const env = config.environment ?? {};
  const baseline = env.network_mode ?? (env.allow_internet === false ? 'no-network' : 'public');
  const category = config.metadata && typeof config.metadata.category === 'string' ? config.metadata.category : null;
  return {
    config,
    summary: {
      name: config.task?.name ?? '(unnamed)',
      canary: canaryMatch?.[1] ?? null,
      agentTimeoutSec: config.agent?.timeout_sec ?? null,
      verifierTimeoutSec: config.verifier?.timeout_sec ?? 600,
      network: {
        environment: baseline,
        agent: config.agent?.network_mode ?? baseline,
        verifier: config.verifier?.network_mode ?? baseline,
        agentAllowedHosts: config.agent?.allowed_hosts ?? [],
      },
      resources: { cpus: env.cpus ?? null, memoryMb: env.memory_mb ?? null, storageMb: env.storage_mb ?? null },
      dockerImage: env.docker_image ?? null,
      verifierMode: config.verifier?.environment_mode ?? (config.verifier?.environment ? 'separate' : 'default'),
      category,
    },
  };
}

export interface HarborTask {
  dir: string;
  config: HarborTaskConfig;
  summary: HarborTaskSummary;
  /** Content hash of the task directory (instruction, environment, tests, solution, task.toml). */
  checksum: string;
  hasInstruction: boolean;
  hasTests: boolean;
  hasSolution: boolean;
}

export async function loadHarborTask(dir: string): Promise<HarborTask> {
  const source = await readFile(join(dir, 'task.toml'), 'utf8');
  const { config, summary } = parseHarborTaskToml(source);
  return {
    dir,
    config,
    summary,
    checksum: await hashTree(dir),
    hasInstruction: existsSync(join(dir, 'instruction.md')),
    hasTests: existsSync(join(dir, 'tests', 'test.sh')) || existsSync(join(dir, 'tests', 'test.bat')),
    hasSolution: existsSync(join(dir, 'solution')),
  };
}

// ------------------------------------------------------------------ harbor run

export interface HarborRunOptions {
  /** Registry dataset `name@version` (exclusive with `path`). */
  dataset?: string;
  /** Local dataset/task directory (exclusive with `dataset`). */
  path?: string;
  /** Pre-integrated agent name or `module.path:ClassName`. */
  agent: string;
  model?: string;
  /** `-k`: attempts per task × agent (fresh trials). */
  attempts: number;
  /** `-n`: concurrent trials. */
  concurrency: number;
  /** `-e`: sandbox provider (docker locally; modal/daytona are cloud services). */
  environment: string;
  jobsDir: string;
  jobName: string;
  include?: string[];
  exclude?: string[];
  /** `--ak key=value` (no secrets: these are printed). */
  agentKwargs?: Record<string, string>;
  /** `--ae NAME=$NAME`: names only; values come from the environment at run time and are never printed. */
  agentEnvNames?: string[];
  /** `--allow-agent-host` (SWE-bench Pro V2 model-endpoint exception). */
  allowAgentHosts?: string[];
  effort?: string;
  /** Resource overrides — any override makes the run non-official. */
  overrides?: { cpus?: number; memoryMb?: number; storageMb?: number };
  /** PYTHONPATH for custom/locked agents (SWE-bench Pro V2 tooling). */
  pythonPath?: string;
}

export interface CommandLine {
  env: Record<string, string>;
  argv: string[];
}

export function buildHarborRun(options: HarborRunOptions): CommandLine {
  if (Boolean(options.dataset) === Boolean(options.path)) throw new Error('exactly one of dataset or path is required');
  const argv = ['harbor', 'run'];
  if (options.dataset) argv.push('-d', options.dataset);
  if (options.path) argv.push('-p', options.path);
  for (const pattern of options.include ?? []) argv.push('-i', pattern);
  for (const pattern of options.exclude ?? []) argv.push('-x', pattern);
  argv.push('-e', options.environment, '-n', String(options.concurrency), '-k', String(options.attempts), '-a', options.agent);
  if (options.model) argv.push('-m', options.model);
  if (options.effort) argv.push('--effort', options.effort);
  for (const [key, value] of Object.entries(options.agentKwargs ?? {})) argv.push('--ak', `${key}=${value}`);
  for (const name of options.agentEnvNames ?? []) argv.push('--ae', `${name}=$${name}`);
  for (const host of options.allowAgentHosts ?? []) argv.push('--allow-agent-host', host);
  if (options.overrides?.cpus !== undefined) argv.push('--override-cpus', String(options.overrides.cpus));
  if (options.overrides?.memoryMb !== undefined) argv.push('--override-memory-mb', String(options.overrides.memoryMb));
  if (options.overrides?.storageMb !== undefined) argv.push('--override-storage-mb', String(options.overrides.storageMb));
  argv.push('-o', options.jobsDir, '--job-name', options.jobName);
  return { env: options.pythonPath ? { PYTHONPATH: options.pythonPath } : {}, argv };
}

export function renderCommand(command: CommandLine): string {
  const quote = (arg: string) => (/^[\w@%+=:,./$-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);
  const env = Object.entries(command.env).map(([k, v]) => `${k}=${quote(v)}`);
  return [...env, ...command.argv.map(quote)].join(' ');
}

/** Official-fidelity runs keep the suite's published resources/timeouts and use full fresh trials. */
export function officialFidelityProblems(options: HarborRunOptions, rules: { minAttempts: number; allowSubset: boolean }): string[] {
  const problems: string[] = [];
  if (options.overrides && Object.keys(options.overrides).length > 0) problems.push('resource overrides change the published environment');
  if (options.attempts < rules.minAttempts) problems.push(`fewer than ${rules.minAttempts} attempts per task`);
  if (!rules.allowSubset && ((options.include?.length ?? 0) > 0 || (options.exclude?.length ?? 0) > 0)) problems.push('task subset selected (report it as a named subset, not the official score)');
  return problems;
}

// ------------------------------------------------------------------ job ingestion

const TimingSchema = z.object({ started_at: z.string().nullable().optional(), finished_at: z.string().nullable().optional() }).nullable().optional();

export const HarborTrialResultSchema = z
  .object({
    task_name: z.string(),
    trial_name: z.string(),
    task_checksum: z.string(),
    agent_info: z.object({ name: z.string(), version: z.string(), model_info: z.object({ name: z.string(), provider: z.string().nullable().optional() }).nullable().optional() }).passthrough(),
    agent_result: z
      .object({
        n_input_tokens: z.number().nullable().optional(),
        n_cache_tokens: z.number().nullable().optional(),
        n_output_tokens: z.number().nullable().optional(),
        cost_usd: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    verifier_result: z.object({ rewards: z.record(z.number()).nullable().optional() }).passthrough().nullable().optional(),
    exception_info: z.object({ exception_type: z.string(), exception_message: z.string() }).passthrough().nullable().optional(),
    started_at: z.string().nullable().optional(),
    finished_at: z.string().nullable().optional(),
    environment_setup: TimingSchema,
    agent_setup: TimingSchema,
    agent_execution: TimingSchema,
    verifier: TimingSchema,
  })
  .passthrough();

export type HarborTrialResult = z.infer<typeof HarborTrialResultSchema>;

/**
 * Harbor's failure classification (error_policy.py) mapped to our
 * termination classes: sandbox/provider/harbor failures are infra, budget
 * exhaustion and refusals are valid agent measurements, verifier failures
 * are grading infra, NonZeroAgentExitCode is the agent's own error.
 */
const HARBOR_TERMINATION: Record<string, Termination> = {
  // SANDBOX_FAILED
  EnvironmentStartTimeoutError: 'infra',
  SandboxBuildFailedError: 'infra',
  AgentSetupTimeoutError: 'infra',
  HealthcheckError: 'infra',
  SandboxLikelyOutOfMemoryError: 'infra',
  MemoryLimitExceededError: 'infra',
  // MODEL_PROVIDER_FAILED
  ApiError: 'infra',
  ApiRateLimitError: 'infra',
  ApiInternalServerError: 'infra',
  ApiOverloadedError: 'infra',
  ApiConnectionError: 'infra',
  NetworkConnectionError: 'infra',
  RateLimitError: 'infra',
  InternalServerError: 'infra',
  ServiceUnavailableError: 'infra',
  AuthenticationError: 'infra',
  AgentAuthenticationError: 'infra',
  ModelNotFoundError: 'infra',
  // UNCLASSIFIED
  NonZeroAgentExitCodeError: 'agent-error',
  // AGENT_EXHAUSTED_BUDGET
  AgentTimeoutError: 'timeout',
  ContextWindowExceededError: 'budget',
  OutputTokenExceededError: 'budget',
  ContextLengthExceededError: 'budget',
  OutputLengthExceededError: 'budget',
  // AGENT_REFUSED_TASK
  AgentSafetyRefusalError: 'refused',
  ContentPolicyViolationError: 'refused',
  // CANCELLED
  CancelledError: 'cancelled',
};
const VERIFIER_FAILURES = new Set(['VerifierTimeoutError', 'RewardFileNotFoundError', 'RewardFileEmptyError', 'VerifierOutputParseError']);

export function harborReward(result: HarborTrialResult): number | null {
  const rewards = result.verifier_result?.rewards;
  if (!rewards) return null;
  if (typeof rewards.reward === 'number') return rewards.reward;
  const values = Object.values(rewards);
  return values.length === 1 ? (values[0] as number) : null;
}

export function classifyHarborTrial(result: HarborTrialResult): { termination: Termination; outcome: Outcome; success: boolean; reason: string } {
  const type = result.exception_info?.exception_type ?? null;
  const reward = harborReward(result);
  if (type && VERIFIER_FAILURES.has(type)) return { termination: 'completed', outcome: 'infra', success: false, reason: `verifier failure: ${type}` };
  const termination: Termination = type ? (HARBOR_TERMINATION[type] ?? 'agent-error') : 'completed';
  if (termination === 'infra' || termination === 'cancelled') return { termination, outcome: 'infra', success: false, reason: type ?? termination };
  if (reward === null) return { termination, outcome: 'infra', success: false, reason: `no valid reward${type ? ` (${type})` : ''}` };
  if (reward >= 1) return { termination, outcome: 'pass', success: true, reason: type ? `pass (reward ${reward}) after ${type}` : `reward ${reward}` };
  if (termination === 'timeout' || termination === 'budget') return { termination, outcome: 'timeout', success: false, reason: type ?? termination };
  if (termination === 'refused') return { termination, outcome: 'refusal', success: false, reason: type ?? 'refused' };
  return { termination, outcome: 'fail', success: false, reason: `reward ${reward}${type ? ` (${type})` : ''}` };
}

function ms(timing: { started_at?: string | null; finished_at?: string | null } | null | undefined): number {
  if (!timing?.started_at || !timing.finished_at) return 0;
  return Math.max(0, Date.parse(timing.finished_at) - Date.parse(timing.started_at));
}

function harborUsage(result: HarborTrialResult): UsageRecord {
  const ctx = result.agent_result;
  const hasTokens = ctx && (typeof ctx.n_input_tokens === 'number' || typeof ctx.n_output_tokens === 'number');
  const cost = typeof ctx?.cost_usd === 'number' ? ctx.cost_usd : null;
  return {
    // Harbor: n_input_tokens includes cache; cache read/write are not distinguished.
    tokens: hasTokens ? { input: ctx?.n_input_tokens ?? 0, output: ctx?.n_output_tokens ?? 0, cacheRead: ctx?.n_cache_tokens ?? 0, cacheWrite: 0, reasoning: 0 } : null,
    tokenBasis: hasTokens ? 'runner-reported' : 'unknown',
    tokenSemantics: hasTokens ? 'cache-in-input' : 'unknown',
    costUsd: cost,
    costBasis: cost !== null ? 'runner-reported' : 'unknown',
    costSource: cost !== null ? `harbor agent_result.cost_usd (${result.agent_info.name} ${result.agent_info.version}; agent-computed)` : 'harbor reported no cost',
  };
}

async function findResultFiles(jobDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(jobDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(jobDir, entry.name, 'result.json');
    if (existsSync(candidate)) out.push(candidate);
  }
  return out.sort();
}

/**
 * Converts a Harbor job directory (one trial directory per attempt, each
 * with `result.json`) into trial records for the common statistics and
 * report. Repeats are numbered per task in start order.
 */
export async function ingestHarborJob(input: { jobDir: string; manifest: EvalManifest; configurationId: string; suiteId: string }): Promise<TrialRecord[]> {
  const config = input.manifest.configurations.find((c) => c.id === input.configurationId);
  if (!config) throw new Error(`unknown configuration ${input.configurationId}`);
  const suite = input.manifest.suites.find((s) => s.id === input.suiteId);
  if (!suite) throw new Error(`unknown suite ${input.suiteId}`);
  const results: Array<{ file: string; result: HarborTrialResult }> = [];
  for (const file of await findResultFiles(input.jobDir)) {
    results.push({ file, result: HarborTrialResultSchema.parse(JSON.parse(await readFile(file, 'utf8'))) });
  }
  results.sort((a, b) => (a.result.started_at ?? '').localeCompare(b.result.started_at ?? '') || a.result.trial_name.localeCompare(b.result.trial_name));
  const repeats = new Map<string, number>();
  const digest = manifestDigest(input.manifest);
  return results.map(({ file, result }, order) => {
    const shortName = result.task_name.includes('/') ? (result.task_name.split('/').pop() as string) : result.task_name;
    const ref = suite.tasks.find((t) => t.id === result.task_name || t.id === shortName);
    const repeat = (repeats.get(result.task_name) ?? 0) + 1;
    repeats.set(result.task_name, repeat);
    const classification = classifyHarborTrial(result);
    const agentMs = ms(result.agent_execution);
    const total = result.started_at && result.finished_at ? Date.parse(result.finished_at) - Date.parse(result.started_at) : agentMs;
    const slotId = `${config.id}--${shortName}--r${repeat}`;
    return {
      schemaVersion: TRIAL_SCHEMA_VERSION,
      trialId: `${slotId}--a1`,
      slotId,
      attempt: 1,
      supersededBy: null,
      order,
      manifestId: input.manifest.id,
      manifestDigest: digest,
      configurationId: config.id,
      harness: config.harness,
      transport: config.transport,
      runnerId: config.runner.id,
      runnerMode: config.runner.mode,
      suiteId: suite.id,
      taskId: ref?.id ?? shortName,
      taskChecksum: result.task_checksum,
      category: ref?.category ?? 'uncategorized',
      cluster: ref?.cluster ?? ref?.id ?? shortName,
      sealed: ref?.sealed ?? false,
      memoryPromotionAllowed: false,
      repeat,
      termination: classification.termination,
      terminationDetail: result.exception_info ? `${result.exception_info.exception_type}: ${result.exception_info.exception_message.slice(0, 300)}` : 'completed',
      grade: null,
      safety: [],
      outcome: classification.outcome,
      success: classification.success,
      reason: classification.reason,
      gradeValid: classification.outcome !== 'infra',
      usage: harborUsage(result),
      timings: { setupMs: ms(result.environment_setup) + ms(result.agent_setup), agentMs, captureMs: 0, gradeMs: ms(result.verifier), taskToArtifactMs: Math.max(0, total - ms(result.verifier)), firstActionMs: null },
      observedModel: result.agent_info.model_info?.name ?? null,
      observedRunnerVersion: result.agent_info.version,
      invocation: null,
      patch: { sha256: sha256Hex(''), bytes: 0, changedPaths: [] },
      artifactsDir: basename(join(file, '..')),
      startedAt: result.started_at ?? '',
      finishedAt: result.finished_at ?? '',
    } satisfies TrialRecord;
  });
}
