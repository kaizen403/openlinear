import { z } from 'zod';
import { canonicalJson, sha256Hex } from '../util/hash';

/**
 * Evaluation manifest (PRD §10): everything that must be frozen before a
 * scored run, so a result can be reproduced or its drift explained.
 *
 * A manifest may be written with floating references (a model alias, a
 * `latest` runner, a branch name). `resolveManifest` turns those into pinned
 * values and records each resolution in `aliases`; `findFloatingRefs` lists
 * what is still unpinned. Only `smoke` manifests may run unpinned.
 */

export const MANIFEST_SCHEMA_VERSION = 'openlinear.eval.manifest/v1' as const;

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase sha256 hex digest');
export const GitShaSchema = z.string().regex(/^[0-9a-f]{40}$/, 'expected a full 40-character git SHA');
export const ImageDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 hex>');
const IsoDateTime = z.string().datetime({ offset: true });
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const NetworkMode = z.enum(['no-network', 'allowlist', 'public']);

export const ImageRefSchema = z
  .object({
    role: z.enum(['environment', 'verifier', 'sidecar']),
    /** Compose service name for sidecar images of multi-container tasks. */
    service: z.string().min(1).optional(),
    /** Human-readable reference as published (may be a tag). */
    ref: z.string().min(1),
    digest: ImageDigestSchema,
    platform: z.string().min(1).default('linux/amd64'),
  })
  .strict();

export const TaskRefSchema = z
  .object({
    id: z.string().min(1),
    /** sha256 of the task definition (instruction, verifier, grader assets, seed repo). */
    checksum: Sha256Schema,
    category: z.string().min(1).optional(),
    /** Bootstrap cluster (defaults to the task id; set to a repository for repo-level resampling). */
    cluster: z.string().min(1).optional(),
    /** Sealed holdout task: never tuned on, never promoted into memory. */
    sealed: z.boolean().default(false),
    images: z.array(ImageRefSchema).default([]),
  })
  .strict();

export const SuiteSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['synthetic-smoke', 'private-holdout', 'terminal-bench', 'swe-bench-pro']),
    name: z.string().min(1),
    version: z.string().min(1),
    source: z
      .object({
        repository: z.string().min(1),
        /** Full commit SHA once frozen; a tag/branch here is a floating reference. */
        revision: z.string().min(1),
        datasetChecksum: Sha256Schema.nullable().default(null),
        config: z.string().nullable().default(null),
        split: z.string().nullable().default(null),
      })
      .strict(),
    /** Run under the suite's own published environment/time/network rules. */
    official: z.boolean(),
    tasks: z.array(TaskRefSchema).min(1),
  })
  .strict();

export const HardwareSchema = z
  .object({
    provider: z.string().min(1),
    os: z.string().min(1),
    arch: z.enum(['arm64', 'x64']),
    cpus: z.number().positive(),
    memoryMb: z.number().int().positive(),
    diskMb: z.number().int().positive().nullable(),
    /** Harbor-style allocation policy; `none` = the host itself, uncontrolled. */
    resourcePolicy: z.enum(['guarantee', 'limit', 'request', 'auto', 'none']),
    headroom: z.string().nullable().default(null),
  })
  .strict();

export const ConcurrencySchema = z
  .object({
    maxConcurrentTrials: z.number().int().min(1).max(256),
    order: z.enum(['randomized-interleaved', 'sequential']),
    seed: z.number().int().nonnegative(),
  })
  .strict();

export const ToolchainSchema = z
  .object({
    node: z.string().min(1),
    git: z.string().min(1),
    packageManager: z.string().nullable().default(null),
    python: z.string().nullable().default(null),
    docker: z.string().nullable().default(null),
    harbor: z
      .object({ version: z.string().min(1), revision: z.string().min(1) })
      .strict()
      .nullable()
      .default(null),
    extra: z.record(z.string()).default({}),
  })
  .strict();

export const RunnerRefSchema = z
  .object({
    id: z.enum(['opencode', 'claude-code', 'codex', 'devin-cli', 'oracle', 'nop']),
    /** Exact runner/CLI version; `latest` or a range is a floating reference. */
    binaryVersion: z.string().min(1),
    /** sha256 of the installed binary/artifact; required for release runs with a real runner. */
    binarySha256: Sha256Schema.nullable().default(null),
    sdkVersion: z.string().nullable().default(null),
    /** `fake` replays recorded trajectories; never a benchmark result. */
    mode: z.enum(['real', 'fake']),
  })
  .strict();

export const ModelRefSchema = z
  .object({
    /** As written by the experimenter (may be an alias such as `sonnet`). */
    requested: z.string().min(1),
    /** Resolved immutable snapshot id. Empty until resolved. */
    snapshot: z.string(),
    provider: z.string().min(1),
    endpoint: z.string().nullable().default(null),
    region: z.string().nullable().default(null),
    effort: z.string().nullable().default(null),
    sampling: z
      .object({
        temperature: z.number().nullable().default(null),
        topP: z.number().nullable().default(null),
        seed: z.number().int().nullable().default(null),
      })
      .strict()
      .default({}),
    maxOutputTokens: z.number().int().positive().nullable().default(null),
    contextPolicy: z.string().nullable().default(null),
    /** Adaptive routing must be disclosed; every model used is then recorded per trial. */
    routing: z.enum(['fixed', 'adaptive-disclosed']).default('fixed'),
  })
  .strict();

export const AssetHashesSchema = z
  .object({
    systemContract: Sha256Schema,
    promptTemplate: Sha256Schema,
    tools: Sha256Schema,
    skills: Sha256Schema,
    mcpConfig: Sha256Schema,
  })
  .strict();

/**
 * Run-engine features applied per trial by the harness (W21 ablations). Each
 * one reuses the sidecar's own code, loaded at run time (features/sidecar.ts),
 * so an arm measures what production runs get. Absent = not applied. The
 * block is part of the configuration, hence of `manifestDigest`: a frozen
 * manifest pins every knob, including the knowledge fixture's checksum.
 */
export const FeaturesSchema = z
  .object({
    /** W16b: the "Repository context" prompt section (`repositoryContextFor`, the trial checkout indexed at its base commit). */
    repositoryContext: z
      .object({
        /** Section budget; the sidecar clamps OPENLINEAR_REPO_CONTEXT_MAX_CHARS to the same 1 000–20 000 (default 6 000). */
        maxChars: z.number().int().min(1000).max(20_000),
        maxFiles: z.number().int().min(1).max(20).default(6),
      })
      .strict()
      .optional(),
    /** W19b: the "## Project knowledge" prompt section (`projectKnowledgeSection`) from a per-suite fixture. */
    knowledge: z
      .object({
        /** Fixture file stem in the knowledge directory (`<dir>/<fixture>.json`). */
        fixture: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'fixture name (file stem)'),
        /** sha256 of the fixture file: the manifest pins the exact entries given to the agent. */
        checksum: Sha256Schema,
      })
      .strict()
      .optional(),
    /** W19a: an independent review pass after the run (deny policy, disposable checkout), then one follow-up turn with its blocker/major findings. */
    reviewer: z
      .object({
        followUp: z.boolean(),
        /** At most this many blocker/major findings go into the follow-up. */
        maxFindings: z.number().int().min(1).max(50),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ConfigurationSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase id'),
    label: z.string().min(1),
    /** `openlinear`: OpenLinear in the loop. `native`: the vendor CLI invoked directly. */
    harness: z.enum(['openlinear', 'native']),
    /** openlinear: `adapter` (runner adapter + sandbox) or `api` (API + sidecar). native: `cli`. */
    transport: z.enum(['adapter', 'api', 'cli']),
    runner: RunnerRefSchema,
    model: ModelRefSchema,
    assets: AssetHashesSchema,
    /** OpenLinear feature flags under test (context, verifier, recovery…); empty for native. */
    enhancements: z.record(z.boolean()).default({}),
    /** Features the harness applies to every trial of this configuration (optional, so older digests are unchanged). */
    features: FeaturesSchema.optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.harness === 'native' && config.transport !== 'cli') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transport'], message: 'native baselines use the cli transport' });
    }
    if (config.harness === 'openlinear' && config.transport === 'cli') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transport'], message: 'openlinear runs use the adapter or api transport' });
    }
  });

export const SandboxSchema = z
  .object({
    provider: z.string().min(1),
    agentNetwork: NetworkMode,
    allowedHosts: z.array(z.string().min(1)).default([]),
    verifierNetwork: NetworkMode,
    envPolicy: z.enum(['allowlist', 'inherit']),
    /** Fresh HOME/XDG per trial (no cross-task memory or caches). */
    privateHome: z.boolean(),
  })
  .strict();

export const BudgetsSchema = z
  .object({
    agentTimeoutMs: z.number().int().positive(),
    verifierTimeoutMs: z.number().int().positive(),
    maxUsdPerTask: z.number().positive().nullable().default(null),
    maxTokensPerTask: z.number().int().positive().nullable().default(null),
    maxTurns: z.number().int().positive().nullable().default(null),
    /** Stop at the first cap reached (PRD §10 budget ladder). */
    stopRule: z.literal('first-cap').default('first-cap'),
    /** Reserved headroom for in-flight overshoot, percent of the cap. */
    headroomPct: z.number().min(0).max(100).default(10),
    /** Grade the patch captured at a timeout/budget stop (SWE-bench Pro V2 does). */
    gradeOnTimeout: z.boolean().default(true),
  })
  .strict();

export const RetriesSchema = z
  .object({
    /** Predeclared reruns of verified platform failures only, applied identically to every configuration. */
    infraRetries: z.number().int().min(0).max(3),
    retryOutcomes: z.array(z.literal('infra')).default(['infra']),
    /** Original outcomes are always retained (intent-to-run view). */
    keepOriginal: z.literal(true).default(true),
  })
  .strict();

export const PriceSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    currency: z.literal('USD'),
    inputPerMTok: z.number().nonnegative(),
    outputPerMTok: z.number().nonnegative(),
    cacheReadPerMTok: z.number().nonnegative().nullable(),
    cacheWritePerMTok: z.number().nonnegative().nullable(),
    asOf: IsoDate,
    source: z.string().min(1),
  })
  .strict();

export const VerifierRefSchema = z
  .object({
    /** Verifier code revision (git SHA, or the grader-asset hash for private tasks). */
    revision: z.string().min(1),
    /** sha256 over every task's grader assets. */
    graderAssets: Sha256Schema,
    method: z.enum(['pristine-checkout', 'harbor-separate-verifier', 'patch-replay']),
  })
  .strict();

export const ContaminationSchema = z
  .object({
    sealedHoldoutPresent: z.boolean(),
    crossTaskMemoryReset: z.boolean(),
    solutionLookup: z.enum(['blocked', 'audited', 'not-applicable']),
    historySanitized: z.boolean(),
    /** Public canary GUIDs/strings that must never appear in agent output. Not secrets. */
    canaries: z.array(z.string().min(8)).default([]),
  })
  .strict();

export const AnalysisSchema = z
  .object({
    primaryMetric: z.literal('single-attempt-success').default('single-attempt-success'),
    bootstrapResamples: z.number().int().min(100).max(100_000).default(2000),
    confidence: z.number().gt(0.5).lt(1).default(0.95),
    clusterBy: z.enum(['task', 'cluster']).default('task'),
    /** Preregistered practical improvement threshold, in percentage points. */
    practicalThresholdPts: z.number().nonnegative().nullable().default(null),
    nonInferiorityMarginPts: z.number().nonnegative().nullable().default(null),
    comparisons: z
      .array(z.object({ treatment: z.string().min(1), baseline: z.string().min(1) }).strict())
      .default([]),
    categories: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const AliasResolutionSchema = z
  .object({
    field: z.string().min(1),
    requested: z.string(),
    resolved: z.string(),
    source: z.string().min(1),
    resolvedAt: IsoDateTime,
  })
  .strict();

export const DriftNoticeSchema = z
  .object({
    field: z.string().min(1),
    expected: z.string(),
    observed: z.string(),
    severity: z.enum(['blocking', 'warning', 'info']),
    detectedAt: IsoDateTime,
    note: z.string().default(''),
  })
  .strict();

export const EvalManifestSchema = z
  .object({
    schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    title: z.string().min(1),
    createdAt: IsoDateTime,
    purpose: z.enum(['smoke', 'development', 'validation', 'release']),
    /** `ablation`: paired arms identical except for `features` (W21: W16b / W19a / W19b). */
    track: z.enum(['deterministic-smoke', 'harness-parity', 'named-stack', 'product-budget', 'official-fidelity', 'observational', 'ablation']),
    /** Fresh independent first-attempt trials per task × configuration. */
    repeats: z.number().int().min(1).max(50),
    suites: z.array(SuiteSchema).min(1),
    hardware: HardwareSchema,
    concurrency: ConcurrencySchema,
    toolchain: ToolchainSchema,
    configurations: z.array(ConfigurationSchema).min(1),
    sandbox: SandboxSchema,
    budgets: BudgetsSchema,
    retries: RetriesSchema,
    prices: z.array(PriceSchema).default([]),
    verifier: VerifierRefSchema,
    contamination: ContaminationSchema,
    analysis: AnalysisSchema,
    aliases: z.array(AliasResolutionSchema).default([]),
    /** Retained drift notices; never cleared, never part of the digest. */
    drift: z.array(DriftNoticeSchema).default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const ids = new Set<string>();
    manifest.configurations.forEach((config, index) => {
      if (ids.has(config.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['configurations', index, 'id'], message: `duplicate configuration ${config.id}` });
      ids.add(config.id);
    });
    manifest.analysis.comparisons.forEach((pair, index) => {
      for (const side of ['treatment', 'baseline'] as const) {
        if (!ids.has(pair[side])) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['analysis', 'comparisons', index, side], message: `unknown configuration ${pair[side]}` });
      }
      if (pair.treatment === pair.baseline) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['analysis', 'comparisons', index], message: 'a configuration cannot be compared with itself' });
    });
    const taskIds = new Set<string>();
    manifest.suites.forEach((suite, s) => {
      suite.tasks.forEach((task, t) => {
        const key = `${suite.id}/${task.id}`;
        if (taskIds.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suites', s, 'tasks', t, 'id'], message: `duplicate task ${key}` });
        taskIds.add(key);
      });
    });
    if (manifest.purpose === 'release' && manifest.repeats < 5) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repeats'], message: 'release evidence needs at least five fresh trials per task/configuration (PRD §10)' });
    }
    if (manifest.track === 'official-fidelity') {
      manifest.suites.forEach((suite, s) => {
        if (!suite.official) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suites', s, 'official'], message: 'an official-fidelity track must use the suite’s published rules' });
      });
    }
    const fake = manifest.configurations.some((config) => config.runner.mode === 'fake');
    if (fake && manifest.purpose !== 'smoke') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['configurations'], message: 'fake (replayed) runners are only allowed in smoke manifests' });
    }
    const sealed = manifest.suites.some((suite) => suite.tasks.some((task) => task.sealed));
    if (sealed && (manifest.purpose === 'development' || manifest.purpose === 'validation')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['suites'], message: 'sealed holdout tasks may only run in release (or offline smoke) manifests — never while tuning' });
    }
    if (sealed !== manifest.contamination.sealedHoldoutPresent) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contamination', 'sealedHoldoutPresent'], message: 'must match whether any task is sealed' });
    }
    if (manifest.track === 'ablation') {
      if (manifest.analysis.comparisons.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['analysis', 'comparisons'], message: 'an ablation needs at least one treatment/baseline comparison' });
      }
      manifest.analysis.comparisons.forEach((pair, index) => {
        const treatment = manifest.configurations.find((config) => config.id === pair.treatment);
        const baseline = manifest.configurations.find((config) => config.id === pair.baseline);
        if (!treatment || !baseline) return;
        // Paired arms: the same runner, model, transport and assets; only the features (and their flags) differ.
        if (canonicalJson(armIdentity(treatment)) !== canonicalJson(armIdentity(baseline))) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['analysis', 'comparisons', index], message: 'ablation arms must be identical except for `features` (harness, transport, runner, model and assets)' });
        }
        if (canonicalJson(treatment.features ?? {}) === canonicalJson(baseline.features ?? {})) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['analysis', 'comparisons', index], message: 'the treatment must enable a feature the baseline does not' });
        }
      });
    }
  });

/** What must match between ablation arms: everything but the id, label, features and their flags. */
function armIdentity(config: z.infer<typeof ConfigurationSchema>): unknown {
  const { id: _id, label: _label, features: _features, enhancements: _enhancements, ...rest } = config;
  return rest;
}

export type EvalManifest = z.infer<typeof EvalManifestSchema>;
export type EvalManifestInput = z.input<typeof EvalManifestSchema>;
export type Configuration = z.infer<typeof ConfigurationSchema>;
export type Features = z.infer<typeof FeaturesSchema>;
export type Suite = z.infer<typeof SuiteSchema>;
export type TaskRef = z.infer<typeof TaskRefSchema>;
export type Price = z.infer<typeof PriceSchema>;
export type DriftNotice = z.infer<typeof DriftNoticeSchema>;
export type AliasResolution = z.infer<typeof AliasResolutionSchema>;

export function parseManifest(input: unknown): EvalManifest {
  return EvalManifestSchema.parse(input);
}

/** Digest of the frozen configuration: the manifest minus its retained drift notices. */
export function manifestDigest(manifest: EvalManifest): string {
  const { drift: _drift, ...frozen } = manifest;
  return sha256Hex(canonicalJson(frozen));
}

export function findPrice(manifest: EvalManifest, provider: string, model: string): Price | null {
  return manifest.prices.find((price) => price.provider === provider && price.model === model) ?? null;
}
