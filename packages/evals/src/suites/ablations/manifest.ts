import type { ObservedEnvironment } from '../../manifest/drift';
import { type Configuration, type EvalManifest, EvalManifestSchema, type EvalManifestInput } from '../../manifest/schema';
import { buildSmokeManifest, EVAL_SYSTEM_CONTRACT, FAKE_MODEL, FAKE_SNAPSHOT } from '../../smoke';
import type { LoadedHoldout } from '../../tasks/holdout';
import { graderCanary, SAMPLE_TASKS } from '../../tasks/samples';
import { sha256Hex } from '../../util/hash';
import { ablationDefinition, type AblationName, type KnowledgePin } from './definitions';

/**
 * Ablation manifests. Two shapes over the same definition:
 *
 * - `smoke`: the sample holdout (all five tasks), FAKE adapter runners,
 *   offline — `ablation smoke <name>`;
 * - `funded`: real runners (OpenLinear in the loop, adapter transport) over
 *   the holdout's non-sealed tasks, purpose `validation` (an ablation guides
 *   product decisions, so sealed tasks stay out). It is written with the
 *   floating references the owner must resolve before a run (model
 *   snapshot, runner version, price, holdout revision) — `ablation plan`
 *   lists them; `run --confirm-spend` refuses until they are pinned.
 */

export interface AblationRunnerChoice {
  id: 'opencode' | 'claude-code' | 'codex';
  /** Model as requested (resolved to a snapshot before the run). */
  model: string;
  provider: string;
  endpoint?: string | null;
  effort?: string | null;
  sdkVersion?: string | null;
}

/** The pilot's stack (docs/eval/pilot-manifest.example.json): OpenLinear + Codex, `gpt-6.1-sol`, medium effort. */
export const DEFAULT_FUNDED_RUNNER: AblationRunnerChoice = { id: 'codex', model: 'gpt-6.1-sol', provider: 'openai', endpoint: 'https://api.openai.com/v1', effort: 'medium', sdkVersion: '0.164.0' };

const PROVIDER_HOSTS: Record<string, string[]> = { openai: ['api.openai.com'], anthropic: ['api.anthropic.com'] };

export interface AblationManifestOptions {
  name: AblationName;
  mode: 'smoke' | 'funded';
  holdout: LoadedHoldout;
  environment: ObservedEnvironment;
  repeats: number;
  seed: number;
  concurrency?: number;
  /** Required for project-knowledge. */
  knowledge?: KnowledgePin | null;
  /** Funded only (default: the pilot's stack). */
  runner?: AblationRunnerChoice;
  /** Funded only: the holdout repository commit (otherwise a floating reference to resolve). */
  holdoutRevision?: string;
}

const NONE = sha256Hex('none');

function arm(id: string, label: string, base: Omit<Configuration, 'id' | 'label' | 'features' | 'enhancements'>, features: Configuration['features']): Configuration {
  const flags = Object.fromEntries(Object.keys(features ?? {}).map((name) => [name, true]));
  return { ...base, id, label, enhancements: { systemContract: true, ...flags }, ...(features ? { features } : {}) };
}

export function buildAblationManifest(options: AblationManifestOptions): EvalManifest {
  const definition = ablationDefinition(options.name);
  const features = definition.features(options.knowledge ?? null);
  const assets = { systemContract: sha256Hex(EVAL_SYSTEM_CONTRACT), promptTemplate: sha256Hex('instruction.md verbatim'), tools: NONE, skills: NONE, mcpConfig: NONE };
  const smoke = buildSmokeManifest({ holdout: options.holdout, environment: options.environment, repeats: options.repeats, seed: options.seed, concurrency: options.concurrency });
  const comparisons = [{ treatment: definition.treatmentId, baseline: definition.baselineId }];

  if (options.mode === 'smoke') {
    const base: Omit<Configuration, 'id' | 'label' | 'features' | 'enhancements'> = {
      harness: 'openlinear',
      transport: 'adapter',
      runner: { id: 'opencode', binaryVersion: 'replay-1', binarySha256: null, sdkVersion: null, mode: 'fake' },
      model: { requested: FAKE_MODEL, snapshot: FAKE_SNAPSHOT, provider: 'fake', endpoint: null, region: null, effort: null, sampling: { temperature: null, topP: null, seed: null }, maxOutputTokens: null, contextPolicy: null, routing: 'fixed' },
      assets,
    };
    const draft: EvalManifestInput = {
      ...smoke,
      id: `ablation-${options.name}-smoke`,
      title: `Ablation smoke (FAKE runners): ${definition.title}`,
      track: 'ablation',
      configurations: [arm(definition.baselineId, 'OpenLinear (adapter) — replay, baseline', base, undefined), arm(definition.treatmentId, `OpenLinear (adapter) — replay, ${definition.treatmentLabel}`, base, features)],
      analysis: { ...smoke.analysis, comparisons },
    };
    return EvalManifestSchema.parse(draft);
  }

  const runner = options.runner ?? DEFAULT_FUNDED_RUNNER;
  const base: Omit<Configuration, 'id' | 'label' | 'features' | 'enhancements'> = {
    harness: 'openlinear',
    transport: 'adapter',
    runner: { id: runner.id, binaryVersion: 'latest', binarySha256: null, sdkVersion: runner.sdkVersion ?? null, mode: 'real' },
    model: { requested: runner.model, snapshot: '', provider: runner.provider, endpoint: runner.endpoint ?? null, region: null, effort: runner.effort ?? null, sampling: { temperature: null, topP: null, seed: null }, maxOutputTokens: null, contextPolicy: 'runner default', routing: 'fixed' },
    assets,
  };
  const label = `OpenLinear (adapter) + ${runner.id}`;
  const open = options.holdout.tasks.filter((task) => !task.sealed);
  const samples = new Set(SAMPLE_TASKS.map((task) => task.id));
  const [suite] = smoke.suites;
  if (!suite) throw new Error('the smoke manifest has no suite');
  const draft: EvalManifestInput = {
    ...smoke,
    id: `ablation-${options.name}`,
    title: `Ablation: ${definition.title}`,
    purpose: 'validation',
    track: 'ablation',
    suites: [
      {
        ...suite,
        kind: options.holdout.index.id === 'openlinear-sample-holdout' ? 'synthetic-smoke' : 'private-holdout',
        source: { ...suite.source, repository: options.holdout.root, revision: options.holdoutRevision ?? 'unpinned: the holdout repository commit' },
        // Sealed tasks never run while a product decision is being made (they are release evidence only).
        tasks: suite.tasks.filter((ref) => open.some((task) => task.spec.id === ref.id)).map((ref) => ({ ...ref, sealed: false })),
      },
    ],
    concurrency: { maxConcurrentTrials: options.concurrency ?? 2, order: 'randomized-interleaved', seed: options.seed },
    configurations: [arm(definition.baselineId, `${label}, baseline`, base, undefined), arm(definition.treatmentId, `${label}, ${definition.treatmentLabel}`, base, features)],
    sandbox: { provider: 'macos-seatbelt (sidecar W09a) or an audited trusted-host grant', agentNetwork: 'allowlist', allowedHosts: PROVIDER_HOSTS[runner.provider] ?? [], verifierNetwork: 'no-network', envPolicy: 'allowlist', privateHome: true },
    // The pilot's budgets (PRD §10 cap of $10 per task): the reviewer and follow-up share the cap with the run.
    budgets: { agentTimeoutMs: 3_000_000, verifierTimeoutMs: 600_000, maxUsdPerTask: 10, maxTokensPerTask: 1_000_000, maxTurns: null, stopRule: 'first-cap', headroomPct: 10, gradeOnTimeout: true },
    retries: { infraRetries: 1, retryOutcomes: ['infra'], keepOriginal: true },
    // A dated price for the resolved snapshot must be added before the run (planFundedRun lists it).
    prices: [],
    contamination: { sealedHoldoutPresent: false, crossTaskMemoryReset: true, solutionLookup: 'blocked', historySanitized: true, canaries: open.filter((task) => samples.has(task.spec.id)).map((task) => graderCanary(task.spec.id)) },
    analysis: { ...smoke.analysis, comparisons, categories: [...new Set(open.map((task) => task.spec.category))] },
  };
  return EvalManifestSchema.parse(draft);
}
