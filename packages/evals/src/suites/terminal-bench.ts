import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Suite } from '../manifest/schema';
import { canonicalJson, hashFile, sha256Hex } from '../util/hash';
import { estimateBudget, type BudgetConfiguration, renderBudget } from './budget';
import { buildHarborRun, type HarborRunOptions, loadHarborTask, officialFidelityProblems, renderCommand } from './harbor';

/**
 * Terminal-Bench 4.0 via Harbor.
 * Sources (read 2026-10-26):
 * - https://www.tbench.ai/news/terminal-bench-4-0 — `harbor run -d terminal-bench/terminal-bench@4.0.0`,
 *   flat 8 h agent timeout, resources calibrated with headroom runs, 8 tasks removed / 19 fixed vs 3.0.
 * - GitHub release v4.0.0 (published 2026-08-26, target 452bf305…): assets `prebuilt-images.json`
 *   (sha256 35930574…, 151 063 B; schema_version 1, 66 tasks, 157 images, environment + verifier
 *   digests per task) and `terminal-bench-prebuilt-v4.0.0.tar.gz` (452 MB — not downloaded).
 * - Task format: tasks/<name>/task.toml at 452bf305 (e.g. interleaved-vigenere: schema 1.0,
 *   agent timeout 28 800 s, verifier `environment_mode = "separate"`, 4 CPU / 4 GiB / 10 GiB).
 * - Leaderboard integrity (2026-04-19): ATIF trajectories required for passing trials; an agent
 *   judge reviews them (competitive analysis §6.1). Required trial count per entry unconfirmed.
 */

export const TB4_PIN = {
  dataset: 'terminal-bench/terminal-bench@4.0.0',
  repository: 'https://github.com/harbor-framework/terminal-bench',
  tag: 'v4.0.0',
  commit: '452bf305c6daa62fc59061d22133a7cbc7c1572e',
  publishedAt: '2026-08-26',
  taskCount: 66,
  imageCount: 157,
  agentTimeoutSec: 28_800,
  prebuiltImages: {
    url: 'https://github.com/harbor-framework/terminal-bench/releases/download/v4.0.0/prebuilt-images.json',
    sha256: '35930574da44fe4e90f6741562a9596cdbf02d2b64d639b6c2b7ab2582a4b0e6',
    bytes: 151_063,
  },
  prebuiltTarball: {
    url: 'https://github.com/harbor-framework/terminal-bench/releases/download/v4.0.0/terminal-bench-prebuilt-v4.0.0.tar.gz',
    sha256: '6d2c57cbcb1a75b5cdc0b0f989747fa68cdc65df8ff0a6893045a70ced7e668e',
    bytes: 452_093_597,
  },
  harbor: { version: '0.25.0', commit: 'fdba28fc411e47e8765420a1a063b4918fce3def', releasedAt: '2026-10-25' },
  accessed: '2026-10-26',
} as const;

const ImageSchema = z
  .object({
    task: z.string(),
    /** `environment`, `verifier`, or `sidecar-<service>` for multi-container tasks. */
    role: z.string().min(1),
    kind: z.enum(['environment', 'verifier', 'sidecar']),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    ref: z.string(),
    pinned_ref: z.string(),
    release_ref: z.string(),
    status: z.string(),
    dockerfile: z.string().optional(),
  })
  .passthrough();

export const PrebuiltImagesSchema = z
  .object({
    schema_version: z.literal(1),
    dataset_package: z.string(),
    image_repository: z.string(),
    release_tag: z.string(),
    task_count: z.number().int(),
    image_count: z.number().int(),
    tasks: z.array(
      z
        .object({
          task: z.string(),
          task_package: z.string(),
          source_sha: z.string().regex(/^[0-9a-f]{40}$/),
          release_tag: z.string(),
          images: z.array(ImageSchema).min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type PrebuiltImages = z.infer<typeof PrebuiltImagesSchema>;

export interface Tb4TaskImages {
  task: string;
  taskPackage: string;
  sourceSha: string;
  environment: { ref: string; digest: string } | null;
  verifier: { ref: string; digest: string } | null;
  /** Multi-container tasks: extra service images (docker compose sidecars). */
  sidecars: Array<{ service: string; ref: string; digest: string }>;
  /** sha256 of the canonical image entry — provisional identity until the task directory is hashed from the pinned checkout. */
  entryChecksum: string;
}

export function parsePrebuiltImages(json: unknown, options: { expectComplete?: boolean } = {}): { manifest: PrebuiltImages; tasks: Tb4TaskImages[]; problems: string[] } {
  const manifest = PrebuiltImagesSchema.parse(json);
  const problems: string[] = [];
  if (manifest.release_tag !== TB4_PIN.tag) problems.push(`release_tag ${manifest.release_tag} ≠ ${TB4_PIN.tag}`);
  if (manifest.dataset_package !== 'terminal-bench/terminal-bench') problems.push(`unexpected dataset package ${manifest.dataset_package}`);
  if (options.expectComplete !== false) {
    if (manifest.task_count !== manifest.tasks.length) problems.push(`task_count ${manifest.task_count} ≠ ${manifest.tasks.length} entries`);
    if (manifest.task_count !== TB4_PIN.taskCount) problems.push(`task_count ${manifest.task_count} ≠ pinned ${TB4_PIN.taskCount}`);
    const images = manifest.tasks.reduce((n, t) => n + t.images.length, 0);
    if (images !== manifest.image_count) problems.push(`image_count ${manifest.image_count} ≠ ${images} listed images`);
  }
  const tasks = manifest.tasks.map((entry) => {
    if (entry.source_sha !== TB4_PIN.commit) problems.push(`${entry.task}: source_sha ${entry.source_sha} ≠ pinned ${TB4_PIN.commit}`);
    const pick = (kind: 'environment' | 'verifier') => {
      const image = entry.images.find((i) => i.kind === kind);
      return image ? { ref: image.pinned_ref, digest: image.digest } : null;
    };
    for (const image of entry.images) if (image.status !== 'built' && image.status !== 'cached') problems.push(`${entry.task}/${image.role}: image status ${image.status}`);
    const sidecars = entry.images.filter((i) => i.kind === 'sidecar').map((i) => ({ service: i.role.replace(/^sidecar-/, ''), ref: i.pinned_ref, digest: i.digest }));
    if (!pick('verifier')) problems.push(`${entry.task}: no separate verifier image`);
    return { task: entry.task, taskPackage: entry.task_package, sourceSha: entry.source_sha, environment: pick('environment'), verifier: pick('verifier'), sidecars, entryChecksum: sha256Hex(canonicalJson(entry)) };
  });
  return { manifest, tasks, problems };
}

/**
 * Manifest suite for TB 4.0. With `checkoutDir` (a clone of the pinned
 * commit) each task checksum is the task-directory hash; without it the
 * checksum is the image-entry hash and is reported as provisional.
 */
export async function tb4Suite(tasks: readonly Tb4TaskImages[], options: { checkoutDir?: string; official: boolean }): Promise<{ suite: Suite; provisional: boolean; categories: Map<string, string> }> {
  const categories = new Map<string, string>();
  const refs = [];
  let provisional = false;
  for (const task of tasks) {
    let checksum = task.entryChecksum;
    let category: string | undefined;
    const dir = options.checkoutDir ? join(options.checkoutDir, 'tasks', task.task) : null;
    if (dir && existsSync(join(dir, 'task.toml'))) {
      const loaded = await loadHarborTask(dir);
      checksum = loaded.checksum;
      category = loaded.summary.category ?? undefined;
      if (category) categories.set(task.task, category);
    } else {
      provisional = true;
    }
    refs.push({
      id: task.task,
      checksum,
      ...(category ? { category } : {}),
      sealed: false,
      images: [
        ...(task.environment ? [{ role: 'environment' as const, ref: task.environment.ref, digest: task.environment.digest, platform: 'linux/amd64' }] : []),
        ...(task.verifier ? [{ role: 'verifier' as const, ref: task.verifier.ref, digest: task.verifier.digest, platform: 'linux/amd64' }] : []),
        ...task.sidecars.map((sidecar) => ({ role: 'sidecar' as const, service: sidecar.service, ref: sidecar.ref, digest: sidecar.digest, platform: 'linux/amd64' })),
      ],
    });
  }
  return {
    suite: {
      id: 'terminal-bench-4.0.0',
      kind: 'terminal-bench',
      name: TB4_PIN.dataset,
      version: '4.0.0',
      source: { repository: TB4_PIN.repository, revision: TB4_PIN.commit, datasetChecksum: TB4_PIN.prebuiltImages.sha256, config: null, split: null },
      official: options.official,
      tasks: refs,
    },
    provisional,
    categories,
  };
}

export interface Tb4AgentPlan {
  configurationId: string;
  /** Harbor agent: pre-integrated name or `module:Class`. */
  agent: string;
  model: string;
  effort?: string;
  agentEnvNames: string[];
  /** Mean cost per trial for the budget (pilot-measured or labelled assumption). */
  meanCostUsd: number;
  meanMinutes?: number;
  costBasis: string;
  implemented: boolean;
  note?: string;
}

/** Default TB 4.0 plan: paired harness-parity configurations (competitive analysis §6.3 Track A). */
export const TB4_DEFAULT_AGENTS: readonly Tb4AgentPlan[] = [
  {
    configurationId: 'native-codex',
    agent: 'codex',
    model: 'openai/<pinned-snapshot>',
    agentEnvNames: ['OPENAI_API_KEY'],
    meanCostUsd: 1.72,
    costBasis: 'assumption: Vals TB4 GPT-6.1 Sol mini-SWE-agent $/task (competitive analysis §6.5); replace with pilot mean',
    implemented: true,
  },
  {
    configurationId: 'openlinear-codex',
    agent: 'openlinear_harbor.agent:OpenLinearInstalledAgent',
    model: 'openai/<pinned-snapshot>',
    agentEnvNames: ['OPENAI_API_KEY'],
    meanCostUsd: 1.72,
    costBasis: 'assumption: same model as native-codex; replace with pilot mean',
    implemented: false,
    note: 'Harbor custom agent (BaseInstalledAgent) wrapping the OpenLinear runner contract — not written yet (ledger follow-up F1).',
  },
  {
    configurationId: 'native-opencode',
    agent: 'opencode',
    model: '<provider>/<pinned-open-model>',
    agentEnvNames: ['OPENROUTER_API_KEY'],
    meanCostUsd: 5.23,
    costBasis: 'assumption: Artificial Analysis OpenCode + GLM-5.3 $/task (competitive analysis §6.1); replace with pilot mean',
    implemented: true,
  },
  {
    configurationId: 'openlinear-opencode',
    agent: 'openlinear_harbor.agent:OpenLinearInstalledAgent',
    model: '<provider>/<pinned-open-model>',
    agentEnvNames: ['OPENROUTER_API_KEY'],
    meanCostUsd: 5.23,
    costBasis: 'assumption: same model as native-opencode; replace with pilot mean',
    implemented: false,
    note: 'Same Harbor custom agent, OpenCode runner.',
  },
];

export interface Tb4DryRunInput {
  imagesManifest: unknown;
  expectComplete?: boolean;
  checkoutDir?: string;
  repeats: number;
  concurrency: number;
  environment: string;
  jobsDir: string;
  agents?: readonly Tb4AgentPlan[];
  contingency: number;
  official: boolean;
}

export interface Tb4DryRun {
  text: string;
  commands: Array<{ configurationId: string; command: string; implemented: boolean }>;
  problems: string[];
  trials: number;
}

/** Prints what a funded TB 4.0 run would execute; runs nothing, pulls nothing. */
export async function tb4DryRun(input: Tb4DryRunInput): Promise<Tb4DryRun> {
  const parsed = parsePrebuiltImages(input.imagesManifest, { expectComplete: input.expectComplete });
  const { suite, provisional } = await tb4Suite(parsed.tasks, { checkoutDir: input.checkoutDir, official: input.official });
  const agents = input.agents ?? TB4_DEFAULT_AGENTS;
  const problems = [...parsed.problems];
  if (provisional) problems.push('task checksums are provisional (image-entry hashes): clone the pinned commit and pass --checkout to hash task directories before freezing the manifest');
  const base: Omit<HarborRunOptions, 'agent' | 'jobName'> = { dataset: TB4_PIN.dataset, attempts: input.repeats, concurrency: input.concurrency, environment: input.environment, jobsDir: input.jobsDir };
  const gates = [
    { configurationId: 'gate-oracle', command: renderCommand(buildHarborRun({ ...base, attempts: 1, agent: 'oracle', jobName: 'tb4-oracle' })), implemented: true },
    { configurationId: 'gate-nop', command: renderCommand(buildHarborRun({ ...base, attempts: 1, agent: 'nop', jobName: 'tb4-nop' })), implemented: true },
  ];
  const commands = agents.map((agent) => {
    const options: HarborRunOptions = { ...base, agent: agent.agent, model: agent.model, effort: agent.effort, agentEnvNames: agent.agentEnvNames, jobName: `tb4-${agent.configurationId}` };
    if (input.official) for (const p of officialFidelityProblems(options, { minAttempts: 5, allowSubset: false })) problems.push(`${agent.configurationId}: ${p}`);
    return { configurationId: agent.configurationId, command: renderCommand(buildHarborRun(options)), implemented: agent.implemented };
  });
  const budget = estimateBudget({
    tasks: suite.tasks.length,
    repeats: input.repeats,
    configurations: agents.map((a): BudgetConfiguration => ({ id: a.configurationId, meanCostUsd: a.meanCostUsd, meanMinutes: a.meanMinutes, basis: a.costBasis })),
    contingency: input.contingency,
    concurrency: input.concurrency,
  });
  const imageDigests = suite.tasks.flatMap((t) => t.images.map((i) => i.digest));
  const lines = [
    `# Terminal-Bench 4.0 dry run (nothing executed, nothing pulled)`,
    '',
    `Dataset ${TB4_PIN.dataset} @ ${TB4_PIN.commit} (release ${TB4_PIN.tag}, ${TB4_PIN.publishedAt}); Harbor ${TB4_PIN.harbor.version} @ ${TB4_PIN.harbor.commit.slice(0, 12)} (pin before running).`,
    `Tasks in manifest: ${suite.tasks.length}; images to pull by digest: ${imageDigests.length} (environment + separate verifier + compose sidecars; ${suite.tasks.filter((t) => t.images.some((i) => i.role === 'sidecar')).length} multi-container task(s)).`,
    `Official agent timeout: ${TB4_PIN.agentTimeoutSec / 3600} h per task (do not shorten for an official-fidelity run).`,
    `Trials: ${suite.tasks.length} tasks × ${input.repeats} repeats × ${agents.length} configurations = ${suite.tasks.length * input.repeats * agents.length}.`,
    '',
    '## Gates (zero inference)',
    ...gates.map((g) => `- ${g.configurationId}: \`${g.command}\``),
    '',
    '## Configurations',
    ...commands.map((c) => `- ${c.configurationId}${c.implemented ? '' : ' (NOT IMPLEMENTED)'}: \`${c.command}\``),
    ...agents.filter((a) => a.note).map((a) => `  - ${a.configurationId}: ${a.note}`),
    '',
    '## Budget (orientation, not authorisation)',
    renderBudget(budget),
    '',
    '## Ingest',
    `After each job: \`pnpm eval:cli ingest-harbor --job ${input.jobsDir}/<job-name> --manifest <frozen manifest> --config <configuration id> --suite ${suite.id}\` → trial records → report.`,
    '',
    '## Problems',
    ...(problems.length ? problems.map((p) => `- ${p}`) : ['- none']),
  ];
  return { text: lines.join('\n'), commands: [...gates, ...commands], problems, trials: suite.tasks.length * input.repeats * agents.length };
}

export async function readImagesManifest(path: string): Promise<{ json: unknown; sha256: string; matchesPin: boolean }> {
  const text = await readFile(path, 'utf8');
  const sha256 = await hashFile(path);
  return { json: JSON.parse(text), sha256, matchesPin: sha256 === TB4_PIN.prebuiltImages.sha256 };
}
