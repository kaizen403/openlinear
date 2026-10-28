import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Suite } from '../manifest/schema';
import { hashFile } from '../util/hash';
import { estimateBudget, type BudgetConfiguration, renderBudget } from './budget';
import { buildHarborRun, type HarborRunOptions, loadHarborTask, renderCommand } from './harbor';

/**
 * SWE-bench Pro V2 (Scale AI), run as Harbor tasks.
 * Sources (read 2026-10-26):
 * - https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/v2/README.md — 642 tasks
 *   (HF `ScaleAI/SWE-bench_Pro`, config `default` = V2, `hard` = HARD-51, `v1` = legacy 731),
 *   task dirs `v2/tasks/<instance_id>/{instruction.md, task.toml, environment/Dockerfile,
 *   solution/{gold_patch.diff,solve.sh}, tests/{test.sh,run_script.sh,parser.py,config.json,test_patch.patch}}`,
 *   image `ghcr.io/scaleapi/swe-bench_pro-v2:<instance_id>` (linux/amd64), 50-minute agent budget,
 *   `[agent] network_mode = "no-network"` with only the model host allowed (`--allow-agent-host`),
 *   `--ak disallowed_tools=WebFetch,WebSearch`, sanitized history, verifier never in the agent sandbox,
 *   oracle 642/642 and nop 0/642 gates, `v2/SHA256SUMS` over every file, locked agents
 *   (`locked_claude_code:LockedClaudeCode`, `locked_codex:LockedCodex`, `locked_mini_swe:LockedMiniSwe`)
 *   and `patch_replay:PatchReplayAgent` for authoritative re-grading ("report the re-graded number; publish both").
 * - Tag v2.0.0 → 66f92766…; commit 31a20c75… (2026-09-22) introduced v2 + SHA256SUMS.
 * - v2/SHA256SUMS sha256 9d84f850… (6 436 lines, 642 task.toml entries); v2/hard51_ids.txt sha256 6e35e847… (51 ids).
 * - Sample task.toml (ansible-40ade1f8): schema 1.4, agent no-network 3000 s, verifier public 3000 s,
 *   1 CPU / 4 GiB / 10 GiB, docker_image pinned by tag (not digest) — record digests at pull time.
 */

export const SWEPRO_V2_PIN = {
  repository: 'https://github.com/scaleapi/SWE-bench_Pro-os',
  tag: 'v2.0.0',
  tagCommit: '66f92766bba642462d4bbe5479e83f91f9211862',
  introducedIn: '31a20c751b0bd56db6510ce7d4d3c269c5b7c72b',
  introducedAt: '2026-09-22',
  huggingFace: { dataset: 'ScaleAI/SWE-bench_Pro', config: 'default', hardConfig: 'hard' },
  taskCount: 642,
  hard51Count: 51,
  sha256sums: { path: 'v2/SHA256SUMS', sha256: '9d84f8507c89241d42d8b3ef911600a1ec75dbbb32687ce9b45b93318502c0bd', lines: 6436 },
  hard51: { path: 'v2/hard51_ids.txt', sha256: '6e35e84708a26443e1746ae928940555a3188654c90f3a2eb691f4f699482bd1' },
  imagePrefix: 'ghcr.io/scaleapi/swe-bench_pro-v2',
  agentTimeoutSec: 3000,
  harborMinimum: '0.22',
  lockedAgents: {
    'claude-code': 'locked_claude_code:LockedClaudeCode',
    codex: 'locked_codex:LockedCodex',
    'mini-swe-agent': 'locked_mini_swe:LockedMiniSwe',
  },
  patchReplay: 'patch_replay:PatchReplayAgent',
  accessed: '2026-10-26',
} as const;

/** `sha256  relative/path` lines (shasum -a 256 format). */
export function parseSha256Sums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[1] && match[2]) out.set(match[2], match[1]);
  }
  return out;
}

/** Verifies files under `v2Dir` against SHA256SUMS (only entries whose prefix matches `onlyPrefix`, if given). */
export async function verifySha256Sums(v2Dir: string, sums: Map<string, string>, onlyPrefix?: string): Promise<{ checked: number; mismatched: string[]; missing: string[] }> {
  const mismatched: string[] = [];
  const missing: string[] = [];
  let checked = 0;
  for (const [path, expected] of sums) {
    if (onlyPrefix && !path.startsWith(onlyPrefix)) continue;
    const absolute = join(v2Dir, path);
    if (!existsSync(absolute)) {
      missing.push(path);
      continue;
    }
    checked += 1;
    if ((await hashFile(absolute)) !== expected) mismatched.push(path);
  }
  return { checked, mismatched, missing };
}

function parsePythonStringList(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const out: string[] = [];
  let i = 1;
  while (i < trimmed.length - 1) {
    const c = trimmed[i] as string;
    if (c === ',' || /\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c !== "'" && c !== '"') return null;
    let value = '';
    i += 1;
    while (i < trimmed.length - 1 && trimmed[i] !== c) {
      if (trimmed[i] === '\\' && i + 1 < trimmed.length - 1) {
        const next = trimmed[i + 1] as string;
        value += { n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' }[next] ?? next;
        i += 2;
        continue;
      }
      value += trimmed[i];
      i += 1;
    }
    if (trimmed[i] !== c) return null;
    out.push(value);
    i += 1;
  }
  return out;
}

/** Test lists in tests/config.json are JSON arrays, JSON-encoded strings, or Python literals (as test.sh accepts). */
export function parseTestList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // fall through to the Python literal form
  }
  return parsePythonStringList(value) ?? [];
}

export interface SweProVerifierConfig {
  failToPass: string[];
  passToPass: string[];
  selectedTests: string[];
}

export function parseSweProConfig(json: unknown): SweProVerifierConfig {
  const record = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  return {
    failToPass: parseTestList(record.fail_to_pass),
    passToPass: parseTestList(record.pass_to_pass),
    selectedTests: parseTestList(record.selected_test_files_to_run),
  };
}

export interface SweProTaskCheck {
  instanceId: string;
  checksum: string;
  image: string | null;
  verifier: SweProVerifierConfig | null;
  problems: string[];
}

/** Checks one V2 task directory against the locked protocol. */
export async function checkSweProTask(taskDir: string, instanceId: string): Promise<SweProTaskCheck> {
  const task = await loadHarborTask(taskDir);
  const problems: string[] = [];
  if (task.summary.network.agent !== 'no-network') problems.push(`agent network ${task.summary.network.agent} ≠ no-network`);
  if (task.summary.agentTimeoutSec !== SWEPRO_V2_PIN.agentTimeoutSec) problems.push(`agent timeout ${task.summary.agentTimeoutSec} ≠ ${SWEPRO_V2_PIN.agentTimeoutSec} s`);
  const expectedImage = `${SWEPRO_V2_PIN.imagePrefix}:${instanceId}`;
  if (task.summary.dockerImage !== expectedImage) problems.push(`docker_image ${task.summary.dockerImage} ≠ ${expectedImage}`);
  if (!task.hasInstruction) problems.push('instruction.md missing');
  if (!task.hasTests) problems.push('tests/test.sh missing');
  let verifier: SweProVerifierConfig | null = null;
  const configPath = join(taskDir, 'tests', 'config.json');
  if (existsSync(configPath)) {
    verifier = parseSweProConfig(JSON.parse(await readFile(configPath, 'utf8')));
    if (verifier.failToPass.length === 0) problems.push('fail_to_pass is empty');
  } else {
    problems.push('tests/config.json missing');
  }
  return { instanceId, checksum: task.checksum, image: task.summary.dockerImage, verifier, problems };
}

export type SweProSubset = 'full' | 'hard51';

export interface SweProAgentPlan {
  configurationId: string;
  agent: string;
  model: string;
  modelHost: string;
  agentKwargs: Record<string, string>;
  agentEnvNames: string[];
  meanCostUsd: number;
  meanMinutes?: number;
  costBasis: string;
  /** Locked agents give an official-protocol self-run; anything else is "self-run, unofficial". */
  locked: boolean;
  implemented: boolean;
  note?: string;
}

export const SWEPRO_DEFAULT_AGENTS: readonly SweProAgentPlan[] = [
  {
    configurationId: 'locked-claude-code',
    agent: SWEPRO_V2_PIN.lockedAgents['claude-code'],
    model: 'anthropic/<pinned-snapshot>',
    modelHost: 'api.anthropic.com',
    agentKwargs: { reasoning_effort: 'high', disallowed_tools: 'WebFetch,WebSearch' },
    agentEnvNames: ['ANTHROPIC_API_KEY'],
    meanCostUsd: 4,
    costBasis: 'assumption (no published per-task V2 cost read); measure in the pilot',
    locked: true,
    implemented: true,
  },
  {
    configurationId: 'locked-codex',
    agent: SWEPRO_V2_PIN.lockedAgents.codex,
    model: 'openai/<pinned-snapshot>',
    modelHost: 'api.openai.com',
    agentKwargs: { config: 'v2/tooling/configs/codex_config.toml' },
    agentEnvNames: ['OPENAI_API_KEY'],
    meanCostUsd: 2,
    costBasis: 'assumption; measure in the pilot',
    locked: true,
    implemented: true,
  },
  {
    configurationId: 'openlinear-claude-code',
    agent: 'openlinear_harbor.agent:OpenLinearInstalledAgent',
    model: 'anthropic/<pinned-snapshot>',
    modelHost: 'api.anthropic.com',
    agentKwargs: { runner: 'claude-code', disallowed_tools: 'WebFetch,WebSearch' },
    agentEnvNames: ['ANTHROPIC_API_KEY'],
    meanCostUsd: 4,
    costBasis: 'assumption: same model as locked-claude-code',
    locked: false,
    implemented: false,
    note: 'Self-run, unofficial. Needs the OpenLinear Harbor agent (follow-up F1); must capture `git diff` as model.patch like the locked agents so patch_replay can re-grade it.',
  },
];

export interface SweProDryRunInput {
  subset: SweProSubset;
  hard51Ids: readonly string[];
  /** Optional local clone of the pinned repo (for checksums / per-task checks). */
  checkoutDir?: string;
  repeats: number;
  concurrency: number;
  /** `docker` locally; the README uses `modal` (a cloud service — a funding decision). */
  environment: string;
  jobsDir: string;
  agents?: readonly SweProAgentPlan[];
  contingency: number;
  /** Check every task dir against SHA256SUMS + protocol when a checkout is given (slow on the full set). */
  verifyCheckout?: boolean;
}

export interface SweProDryRun {
  text: string;
  commands: Array<{ configurationId: string; command: string; implemented: boolean }>;
  problems: string[];
  trials: number;
}

export async function sweProDryRun(input: SweProDryRunInput): Promise<SweProDryRun> {
  const problems: string[] = [];
  const taskCount = input.subset === 'hard51' ? input.hard51Ids.length : SWEPRO_V2_PIN.taskCount;
  if (input.subset === 'hard51' && input.hard51Ids.length !== SWEPRO_V2_PIN.hard51Count) problems.push(`hard51 list has ${input.hard51Ids.length} ids, expected ${SWEPRO_V2_PIN.hard51Count}`);
  const include = input.subset === 'hard51' ? [...input.hard51Ids] : [];
  const path = input.checkoutDir ? join(input.checkoutDir, 'v2', 'tasks') : 'v2/tasks';
  if (input.checkoutDir && input.verifyCheckout) {
    const sumsPath = join(input.checkoutDir, SWEPRO_V2_PIN.sha256sums.path);
    if (!existsSync(sumsPath)) problems.push('SHA256SUMS missing from the checkout');
    else {
      const sha = await hashFile(sumsPath);
      if (sha !== SWEPRO_V2_PIN.sha256sums.sha256) problems.push(`SHA256SUMS sha256 ${sha} ≠ pinned ${SWEPRO_V2_PIN.sha256sums.sha256}`);
      const sums = parseSha256Sums(await readFile(sumsPath, 'utf8'));
      const ids = input.subset === 'hard51' ? input.hard51Ids : (await readdir(join(input.checkoutDir, 'v2', 'tasks'))).sort();
      for (const id of ids) {
        const verified = await verifySha256Sums(join(input.checkoutDir, 'v2'), sums, `tasks/${id}/`);
        for (const p of verified.mismatched) problems.push(`checksum mismatch: ${p}`);
        for (const p of verified.missing) problems.push(`missing: ${p}`);
        const check = await checkSweProTask(join(input.checkoutDir, 'v2', 'tasks', id), id);
        for (const p of check.problems) problems.push(`${id}: ${p}`);
      }
    }
  }
  const agents = input.agents ?? SWEPRO_DEFAULT_AGENTS;
  const base: Omit<HarborRunOptions, 'agent' | 'jobName'> = { path, include, attempts: input.repeats, concurrency: input.concurrency, environment: input.environment, jobsDir: input.jobsDir };
  const tag = input.subset === 'hard51' ? 'sbp-v2-hard51' : 'sbp-v2';
  const gates = [
    { configurationId: 'gate-oracle', command: renderCommand(buildHarborRun({ ...base, attempts: 1, agent: 'oracle', jobName: `${tag}-oracle` })), implemented: true },
    { configurationId: 'gate-nop', command: renderCommand(buildHarborRun({ ...base, attempts: 1, agent: 'nop', jobName: `${tag}-nop` })), implemented: true },
  ];
  const runs = agents.flatMap((agent) => {
    const jobName = `${tag}-${agent.configurationId}`;
    const solve = buildHarborRun({
      ...base,
      agent: agent.agent,
      model: agent.model,
      agentKwargs: agent.agentKwargs,
      agentEnvNames: agent.agentEnvNames,
      allowAgentHosts: [agent.modelHost],
      jobName,
      pythonPath: 'v2/tooling',
    });
    const regrade = buildHarborRun({ ...base, attempts: 1, agent: SWEPRO_V2_PIN.patchReplay, model: 'replay', agentKwargs: { source_job: `${input.jobsDir}/${jobName}` }, jobName: `${jobName}-regrade`, pythonPath: 'v2/tooling' });
    return [
      { configurationId: agent.configurationId, command: renderCommand(solve), implemented: agent.implemented },
      { configurationId: `${agent.configurationId} (re-grade, authoritative)`, command: renderCommand(regrade), implemented: agent.implemented },
    ];
  });
  const budget = estimateBudget({
    tasks: taskCount,
    repeats: input.repeats,
    configurations: agents.map((a): BudgetConfiguration => ({ id: a.configurationId, meanCostUsd: a.meanCostUsd, meanMinutes: a.meanMinutes, basis: a.costBasis })),
    contingency: input.contingency,
    concurrency: input.concurrency,
  });
  const lines = [
    `# SWE-bench Pro V2 dry run — ${input.subset === 'hard51' ? 'HARD-51 subset (lead result)' : 'full 642-task public set'} (nothing executed, nothing pulled)`,
    '',
    `Repository ${SWEPRO_V2_PIN.repository} @ tag ${SWEPRO_V2_PIN.tag} (${SWEPRO_V2_PIN.tagCommit}); SHA256SUMS sha256 ${SWEPRO_V2_PIN.sha256sums.sha256.slice(0, 16)}…; Harbor ≥ ${SWEPRO_V2_PIN.harborMinimum}.`,
    `Tasks: ${taskCount}; images: ${taskCount} × ${SWEPRO_V2_PIN.imagePrefix}:<instance_id> (linux/amd64; record digests at pull time — task.toml pins tags only).`,
    `Protocol: ${SWEPRO_V2_PIN.agentTimeoutSec / 60}-minute agent phase, agent network no-network except the model host, web tools disabled, verifier outside the agent sandbox, patch replay is authoritative.`,
    `Trials: ${taskCount} × ${input.repeats} repeats × ${agents.length} configurations = ${taskCount * input.repeats * agents.length} (+ re-grade passes, no inference).`,
    '',
    '## Gates (zero inference; expect oracle all resolved, nop none resolved)',
    ...gates.map((g) => `- ${g.configurationId}: \`${g.command}\``),
    '',
    '## Configurations (run, then re-grade with patch_replay)',
    ...runs.map((c) => `- ${c.configurationId}${c.implemented ? '' : ' (NOT IMPLEMENTED)'}: \`${c.command}\``),
    ...agents.filter((a) => a.note).map((a) => `  - ${a.configurationId}: ${a.note}`),
    ...agents.filter((a) => !a.locked).map((a) => `  - ${a.configurationId}: label every result "self-run, unofficial".`),
    '',
    '## Budget (orientation, not authorisation)',
    renderBudget(budget),
    '',
    '## Problems',
    ...(problems.length ? problems.map((p) => `- ${p}`) : ['- none']),
  ];
  return { text: lines.join('\n'), commands: [...gates, ...runs], problems, trials: taskCount * input.repeats * agents.length };
}

/** Manifest suite skeleton for the chosen subset (checksums require the pinned checkout). */
export async function sweProSuite(checkoutDir: string, ids: readonly string[], official: boolean): Promise<Suite> {
  const tasks = [];
  for (const id of ids) {
    const check = await checkSweProTask(join(checkoutDir, 'v2', 'tasks', id), id);
    tasks.push({ id, checksum: check.checksum, sealed: false, images: [] });
  }
  return {
    id: ids.length === SWEPRO_V2_PIN.hard51Count ? 'swe-bench-pro-v2-hard51' : 'swe-bench-pro-v2',
    kind: 'swe-bench-pro',
    name: 'SWE-bench Pro V2',
    version: SWEPRO_V2_PIN.tag,
    source: { repository: SWEPRO_V2_PIN.repository, revision: SWEPRO_V2_PIN.tagCommit, datasetChecksum: SWEPRO_V2_PIN.sha256sums.sha256, config: SWEPRO_V2_PIN.huggingFace.config, split: 'test' },
    official,
    tasks,
  };
}
