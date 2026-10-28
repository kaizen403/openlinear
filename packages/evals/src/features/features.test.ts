import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AblationFake } from '../fakes/ablation';
import { mainFile } from '../fakes/recordings';
import { planFundedRun } from '../funded';
import { runEvaluation } from '../harness';
import { manifestDigest, parseManifest } from '../manifest/schema';
import { NativeCliRunner } from '../runners/native/native-runner';
import { OpenLinearAdapterRunner } from '../runners/openlinear-adapter';
import { ReplayAgentRunner } from '../runners/replay-agent-runner';
import type { HarnessRunner, RunnerResult, TrialContext } from '../runners/types';
import { type BaseRepo, cloneForTrial, type LoadedHoldout, loadHoldout, materializeBaseRepo } from '../tasks/holdout';
import { SAMPLE_TASKS, type SampleHoldout, writeSampleHoldout } from '../tasks/samples';
import { testConfiguration, testManifestInput } from '../testing/fixtures';
import { mergeRawUsage, UNKNOWN_USAGE } from '../usage/cost';
import { sha256Hex } from '../util/hash';
import { checkKnowledgeFixture, DEFAULT_KNOWLEDGE_DIR, type KnowledgeEntry, loadKnowledgeFixture, selectPromptKnowledge } from './knowledge';
import { type FeatureEnvironment, FeatureConfigurationError, mergePhaseEvents, runWithFeatures } from './pipeline';
import { loadSidecarFeatures, SidecarFeaturesError } from './sidecar';
import { featureProblems } from './support';
import { enabledFeatures, sessionsPerTrial } from './types';

/** Set before this file loads any sidecar code (the loader only fills it in when it is unset). */
const presetReposDir = process.env.REPOS_DIR;
let root: string;
let sample: SampleHoldout;
let holdout: LoadedHoldout;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'evals-features-'));
  sample = await writeSampleHoldout(join(root, 'holdout'));
  holdout = await loadHoldout(join(root, 'holdout'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const H = sha256Hex('none');
const adapter = (id: string, features?: object) =>
  testConfiguration(id, { harness: 'openlinear', transport: 'adapter', runner: { id: 'opencode', binaryVersion: '1.18.32', binarySha256: null, sdkVersion: null, mode: 'real' }, ...(features ? { features } : {}) });

describe('manifest features (schema and digest)', () => {
  it('validates the feature blocks strictly', () => {
    expect(() => parseManifest(testManifestInput({ configurations: [adapter('a', { repositoryContext: { maxChars: 500 } }), adapter('b')] }))).toThrow();
    expect(() => parseManifest(testManifestInput({ configurations: [adapter('a', { repositoryContext: { maxChars: 6000, extra: 1 } }), adapter('b')] }))).toThrow();
    expect(() => parseManifest(testManifestInput({ configurations: [adapter('a', { knowledge: { fixture: 'x', checksum: 'not-a-sha' } }), adapter('b')] }))).toThrow();
    expect(() => parseManifest(testManifestInput({ configurations: [adapter('a', { reviewer: { followUp: true, maxFindings: 0 } }), adapter('b')] }))).toThrow();
    expect(() => parseManifest(testManifestInput({ configurations: [adapter('a', { memory: {} }), adapter('b')] }))).toThrow();
    const parsed = parseManifest(testManifestInput({ configurations: [adapter('a', { repositoryContext: { maxChars: 6000 } }), adapter('b')] }));
    expect(parsed.configurations[0]?.features?.repositoryContext).toEqual({ maxChars: 6000, maxFiles: 6 });
    expect(enabledFeatures(parsed.configurations[0] ?? {})).toEqual(['repositoryContext']);
  });

  it('includes features in the manifest digest, and leaves feature-less manifests as they were', () => {
    const digest = (features?: object) => manifestDigest(parseManifest(testManifestInput({ configurations: [adapter('a', features), adapter('b')] })));
    const plain = parseManifest(testManifestInput({ configurations: [adapter('a'), adapter('b')] }));
    expect('features' in (plain.configurations[0] ?? {})).toBe(false);
    expect(digest({ repositoryContext: { maxChars: 6000 } })).not.toBe(digest({ repositoryContext: { maxChars: 8000 } }));
    expect(digest({ repositoryContext: { maxChars: 6000 } })).not.toBe(digest());
    expect(digest({ knowledge: { fixture: 'k', checksum: 'a'.repeat(64) } })).not.toBe(digest({ knowledge: { fixture: 'k', checksum: 'b'.repeat(64) } }));
    expect(digest({ reviewer: { followUp: true, maxFindings: 10 } })).not.toBe(digest({ reviewer: { followUp: false, maxFindings: 10 } }));
  });

  it('requires ablation arms to differ only in their features', () => {
    const ablation = (treatment: ReturnType<typeof adapter>, baseline: ReturnType<typeof adapter>) =>
      testManifestInput({ track: 'ablation', configurations: [treatment, baseline], analysis: { comparisons: [{ treatment: treatment.id, baseline: baseline.id }] } });
    expect(() => parseManifest(ablation(adapter('t', { repositoryContext: { maxChars: 6000 } }), adapter('b')))).not.toThrow();
    const otherModel = { ...adapter('b'), model: { ...adapter('b').model, snapshot: 'another-model' } };
    expect(() => parseManifest(ablation(adapter('t', { repositoryContext: { maxChars: 6000 } }), otherModel))).toThrow(/identical except for `features`/);
    expect(() => parseManifest(ablation(adapter('t'), adapter('b')))).toThrow(/enable a feature the baseline does not/);
    expect(() => parseManifest(testManifestInput({ track: 'ablation', configurations: [adapter('t', { repositoryContext: { maxChars: 6000 } }), adapter('b')], analysis: { comparisons: [] } }))).toThrow(/at least one/);
  });
});

describe('feature support (refused at plan time, never run as the baseline)', () => {
  it('lists what each runner path cannot apply', () => {
    const api = testConfiguration('api', { harness: 'openlinear', transport: 'api', features: { repositoryContext: { maxChars: 6000, maxFiles: 6 } } });
    const nativeReviewer = testConfiguration('native-reviewer', { features: { reviewer: { followUp: true, maxFindings: 5 } } });
    const nativeKnowledge = testConfiguration('native-knowledge', { features: { knowledge: { fixture: 'k', checksum: H } } });
    const manifest = parseManifest(testManifestInput({ configurations: [api, nativeReviewer, nativeKnowledge, adapter('ol', { reviewer: { followUp: true, maxFindings: 5 }, repositoryContext: { maxChars: 6000 } })], analysis: { comparisons: [] } }));
    const problems = featureProblems(manifest);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^feature unsupported: api enables repositoryContext on openlinear\/api.*sidecar builds the prompt/);
    expect(problems[1]).toMatch(/^feature unsupported: native-reviewer enables reviewer on native\/cli/);
    const plan = planFundedRun(manifest);
    expect(plan.problems).toEqual(expect.arrayContaining(problems));
    // The reviewer arm can start three sessions per trial; the worst case counts each at the cap.
    expect(plan.configurations.map((c) => c.sessionsPerTrial)).toEqual([1, 3, 1, 3]);
    expect(plan.worstCaseUsd).toBeNull();
    const capped = planFundedRun(parseManifest({ ...testManifestInput({ configurations: [adapter('t', { reviewer: { followUp: false, maxFindings: 5 } }), adapter('b')], analysis: { comparisons: [] } }), budgets: { agentTimeoutMs: 1000, verifierTimeoutMs: 1000, maxUsdPerTask: 10 } }));
    expect(sessionsPerTrial({ features: { reviewer: { followUp: false, maxFindings: 5 } } })).toBe(2);
    // 2 tasks × 3 repeats per arm: 6 × 2 sessions × $10 + 6 × 1 × $10, + 10 % headroom.
    expect(capped.worstCaseUsd).toBeCloseTo((6 * 2 * 10 + 6 * 10) * 1.1, 6);
  });

  it('refuses a feature manifest without a feature environment, or with a runner that cannot apply it', async () => {
    const manifest = parseManifest({
      ...testManifestInput({ purpose: 'smoke', configurations: [{ ...adapter('t', { reviewer: { followUp: true, maxFindings: 5 } }), runner: { id: 'opencode', binaryVersion: 'replay-1', binarySha256: null, sdkVersion: null, mode: 'fake' } }], analysis: { comparisons: [] } }),
      suites: [{ id: 's', kind: 'synthetic-smoke', name: holdout.index.id, version: '1', source: { repository: 'x', revision: 'generated' }, official: false, tasks: holdout.tasks.filter((t) => !t.sealed).map((t) => ({ id: t.spec.id, checksum: t.checksum })) }],
    });
    const replay = new ReplayAgentRunner({ id: 'opencode', pick: new AblationFake({ sources: sample.sources, model: 'm', runner: 'opencode' }).pick });
    const runners = new Map<string, HarnessRunner>([['t', new OpenLinearAdapterRunner({ runner: replay, fake: true })]]);
    await expect(runEvaluation({ manifest, tasks: holdout.tasks, runners, outDir: join(root, 'refuse-1'), systemContract: 'x' })).rejects.toThrow(/would run as the baseline/);
    const env: FeatureEnvironment = { sidecar: await loadSidecarFeatures(), knowledge: new Map(), contextEngine: null, notes: [] };
    const bare: HarnessRunner = { kind: 'bare', run: async () => ({ ...UNKNOWN_RESULT }) };
    await expect(runEvaluation({ manifest, tasks: holdout.tasks, runners: new Map([['t', bare]]), outDir: join(root, 'refuse-2'), systemContract: 'x', features: env })).rejects.toThrow(FeatureConfigurationError);
    // Nothing ran: no trial directories.
    expect(existsSync(join(root, 'refuse-2', 'trials'))).toBe(false);
  });
});

const UNKNOWN_RESULT: RunnerResult = {
  termination: 'completed',
  terminationDetail: 'idle',
  events: [],
  nativeLines: [],
  usage: UNKNOWN_USAGE,
  agentMs: 0,
  firstActionMs: null,
  observedModel: null,
  observedRunnerVersion: null,
  invocation: null,
  logs: [],
};

describe('knowledge fixtures', () => {
  it('selects entries like the control plane: conventions, procedures, notes; ≤ 20 entries and 8 000 characters', () => {
    const entry = (kind: KnowledgeEntry['kind'], title: string, size = 10): KnowledgeEntry => ({ kind, title, body: 'x'.repeat(size), provenance: { author: 'a', derivedFrom: [] } });
    const chosen = selectPromptKnowledge([entry('note', 'n1'), entry('procedure', 'p1'), entry('convention', 'c1'), entry('convention', 'c2')]);
    expect(chosen.map((e) => e.title)).toEqual(['c1', 'c2', 'p1', 'n1']);
    expect(selectPromptKnowledge(Array.from({ length: 30 }, (_, i) => entry('note', `n${i}`)))).toHaveLength(20);
    const big = selectPromptKnowledge([entry('convention', 'big', 3900), entry('convention', 'big2', 3900), entry('convention', 'big3', 3900), entry('note', 'small')]);
    expect(big.map((e) => e.title)).toEqual(['big', 'big2', 'small']);
  });

  it('refuses entries from sealed or validation tasks, grader canaries and a changed file; notes in-sample entries', async () => {
    const loaded = await loadKnowledgeFixture(DEFAULT_KNOWLEDGE_DIR, 'sample-holdout');
    const manifest = parseManifest({
      ...testManifestInput({ purpose: 'smoke', analysis: { comparisons: [] } }),
      suites: [{ id: 's', kind: 'synthetic-smoke', name: holdout.index.id, version: '1', source: { repository: 'x', revision: 'generated' }, official: false, tasks: holdout.tasks.map((t) => ({ id: t.spec.id, checksum: t.checksum, sealed: t.sealed })) }],
      contamination: { sealedHoldoutPresent: true, crossTaskMemoryReset: true, solutionLookup: 'blocked', historySanitized: true, canaries: ['OPENLINEAR-EVAL-GRADER-CANARY-sum-range-inclusive'] },
    });
    const clean = checkKnowledgeFixture({ loaded, expectedChecksum: loaded.checksum, manifest, tasks: holdout.tasks });
    expect(clean.problems).toEqual([]);
    expect(clean.notes.join('\n')).toMatch(/derived from sum-range-inclusive, which this manifest also evaluates/);

    const tainted = structuredClone(loaded);
    tainted.fixture.entries.push(
      { kind: 'convention', title: 'Versions compare numerically', body: 'Split on dots.', provenance: { author: 'a', derivedFrom: ['semver-numeric-compare'] } },
      { kind: 'note', title: 'Durations', body: 'Sum every unit.', provenance: { author: 'a', derivedFrom: ['parse-duration-compound'] } },
      { kind: 'note', title: 'Leak', body: 'Expected: OPENLINEAR-EVAL-GRADER-CANARY-sum-range-inclusive', provenance: { author: 'a', derivedFrom: [] } },
    );
    const check = checkKnowledgeFixture({ loaded: tainted, expectedChecksum: 'f'.repeat(64), manifest, tasks: holdout.tasks });
    expect(check.problems).toEqual([
      expect.stringMatching(/differs from the manifest's f{64}/),
      expect.stringMatching(/"Versions compare numerically" was derived from sealed task semver-numeric-compare — sealed tasks never feed knowledge/),
      expect.stringMatching(/"Durations" was derived from validation task parse-duration-compound/),
      expect.stringMatching(/"Leak" contains grader canary/),
    ]);
    const elsewhere = checkKnowledgeFixture({ loaded: { ...loaded, fixture: { ...loaded.fixture, holdout: 'another-holdout' } }, expectedChecksum: loaded.checksum, manifest, tasks: holdout.tasks });
    expect(elsewhere.problems).toEqual([expect.stringMatching(/written for holdout another-holdout/)]);
  });
});

describe('sidecar feature code (loaded at run time, shape-checked)', () => {
  it('loads the real modules without touching the user app data, and fails loudly elsewhere', async () => {
    const sidecar = await loadSidecarFeatures();
    if (presetReposDir === undefined) {
      // The sidecar creates its repository storage when it loads: a private temp dir, never the user's app data.
      expect(process.env.REPOS_DIR?.includes('openlinear-eval-sidecar-')).toBe(true);
      expect(process.env.REPOS_DIR?.startsWith(homedir())).toBe(false);
    }
    expect(sidecar.projectKnowledgeSection([{ kind: 'convention', title: 'Use pnpm', body: 'Always pnpm.' }])).toBe(
      '## Project knowledge\nWritten or approved by the team for this project. Follow it unless the task says otherwise.\n\n### Use pnpm (convention)\nAlways pnpm.',
    );
    expect(sidecar.projectKnowledgeSection([])).toBeNull();
    expect(sidecar.reviewerSystemContract).toMatch(/^Review contract:/);
    expect(sidecar.parseReviewOutput('no block')).toEqual({ ok: false, error: expect.stringContaining('json') });
    await expect(loadSidecarFeatures(join(root, 'no-sidecar-here'))).rejects.toThrow(SidecarFeaturesError);
  });
});

describe('merging the sessions of a trial', () => {
  it('sums usage only when every session reported it', () => {
    const part = (usd: number | null) => ({
      tokens: { input: 10, output: 5, cacheRead: 1, cacheWrite: 0, reasoning: 0 },
      tokenBasis: 'provider-reported' as const,
      semantics: 'cache-disjoint' as const,
      reportedCostUsd: usd,
      reportedCostBasis: usd === null ? null : ('runner-reported' as const),
      reportedCostSource: usd === null ? null : 'test',
    });
    expect(mergeRawUsage([part(0.1), part(0.2)])).toMatchObject({ reportedCostUsd: expect.closeTo(0.3, 9), tokens: { input: 20, output: 10, cacheRead: 2 } });
    expect(mergeRawUsage([part(0.1), part(null)]).reportedCostUsd).toBeNull();
    expect(mergeRawUsage([part(0.1), UNKNOWN_USAGE]).tokens).toBeNull();
  });

  it('keeps exactly one terminal event, the deciding session\'s, at the end', () => {
    const result = (events: RunnerResult['events']): RunnerResult => ({ ...UNKNOWN_RESULT, events });
    const merged = mergePhaseEvents(
      [
        { phase: 'run', offsetMs: 0, result: result([{ atMs: 5, event: { t: 'turn.started', turn: 1 } }, { atMs: 9, event: { t: 'turn.finished', turn: 1, reason: 'idle' } }]) },
        { phase: 'review', offsetMs: 100, result: result([{ atMs: 1, event: { t: 'error', code: 'refusal', message: 'no', retryable: false } }, { atMs: 2, event: { t: 'turn.finished', turn: 1, reason: 'error' } }]) },
      ],
      'run',
    );
    expect(merged.filter((e) => e.event.t === 'turn.finished' || e.event.t === 'error')).toEqual([{ atMs: 102, event: { t: 'turn.finished', turn: 1, reason: 'idle' } }]);
    expect(merged.at(-1)?.event).toEqual({ t: 'turn.finished', turn: 1, reason: 'idle' });
    expect(merged.some((e) => e.event.t === 'diagnostic' && e.event.code === 'eval.review.error')).toBe(true);
  });
});

describe('runWithFeatures on one trial', () => {
  const bases = new Map<string, BaseRepo>();
  async function context(taskId: string, name: string, configuration: TrialContext['configuration'], manifest: TrialContext['manifest']): Promise<TrialContext> {
    const task = holdout.tasks.find((t) => t.spec.id === taskId);
    if (!task) throw new Error(taskId);
    let base = bases.get(taskId);
    if (!base) {
      base = await materializeBaseRepo(task, join(root, 'work'));
      bases.set(taskId, base);
    }
    const scratch = join(root, 'trials', name);
    await mkdir(scratch, { recursive: true });
    await cloneForTrial(base, join(scratch, 'worktree'));
    return { trialId: `${configuration.id}--${taskId}--r1--a1`, attempt: 1, repeat: 1, task, configuration, manifest, worktree: join(scratch, 'worktree'), baseSha: base.baseSha, scratchDir: scratch, prompt: task.instruction, systemContract: 'eval contract', sealed: task.sealed, signal: new AbortController().signal };
  }

  it('applies prompt sections to a native CLI too (the CLI gets the composed prompt)', async () => {
    const configuration = testConfiguration('native-ctx', { runner: { id: 'codex', binaryVersion: 'replay-cli-1', binarySha256: null, sdkVersion: null, mode: 'fake' }, features: { repositoryContext: { maxChars: 6000, maxFiles: 6 } } });
    const manifest = parseManifest({ ...testManifestInput({ purpose: 'smoke', configurations: [configuration], analysis: { comparisons: [] } }), budgets: { agentTimeoutMs: 20_000, verifierTimeoutMs: 30_000 } });
    const fake = new AblationFake({ sources: sample.sources, model: 'm', runner: 'codex' });
    const runner = new NativeCliRunner({ runner: 'codex', mode: 'fake', killGraceMs: 500, pickRecording: (ctx) => fake.pickNative(ctx, 'codex-jsonl') });
    const sidecar = await loadSidecarFeatures();
    const env: FeatureEnvironment = { sidecar, knowledge: new Map(), contextEngine: sidecar.createContextEngine(), notes: [] };
    const ctx = await context('slugify-collapse', 'native-ctx', configuration, manifest);
    const result = await runWithFeatures({ runner, ctx, env });
    const source = SAMPLE_TASKS.find((t) => t.id === 'slugify-collapse');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.prompt.startsWith(ctx.task.instruction.trimEnd())).toBe(true);
    expect(fake.calls[0]?.prompt).toContain('## Repository context');
    expect(fake.calls[0]?.prompt).toContain(JSON.stringify(source ? mainFile(source) : ''));
    expect(result.features?.repositoryContext).toMatchObject({ section: true, commit: ctx.baseSha, reason: null });
    expect(result.features?.repositoryContext?.citations).toContain('src/slugify.mjs');
    expect(result.prompt).toBe(fake.calls[0]?.prompt);
  });

  it('turns an unavailable repository index into infra instead of running the baseline', async () => {
    const configuration = adapter('ctx', { repositoryContext: { maxChars: 6000, maxFiles: 6 } });
    const manifest = parseManifest(testManifestInput({ configurations: [configuration], analysis: { comparisons: [] } }));
    const sidecar = await loadSidecarFeatures();
    const env: FeatureEnvironment = {
      sidecar: { ...sidecar, repositoryContextFor: async () => ({ section: null, citations: [], receipt: { sha: null, indexedFiles: 0, contentFiles: 0, cacheHit: false, ms: 1 }, reason: 'the repository could not be indexed' }) },
      knowledge: new Map(),
      contextEngine: null,
      notes: [],
    };
    let started = 0;
    const runner: HarnessRunner = { kind: 'counting', featureSupport: { promptSections: true, reviewPhases: true }, run: async () => {
      started += 1;
      return UNKNOWN_RESULT;
    } };
    const result = await runWithFeatures({ runner, ctx: await context('sum-range-inclusive', 'ctx-infra', configuration, manifest), env });
    expect(started).toBe(0);
    expect(result).toMatchObject({ termination: 'infra', startErrorCode: 'EVAL_FEATURE_UNAVAILABLE', terminationDetail: expect.stringContaining('could not be indexed') });
  });
});

describe('fixture files', () => {
  it('ships a valid sample knowledge fixture with an entry for every non-sealed sample task', async () => {
    const loaded = await loadKnowledgeFixture(DEFAULT_KNOWLEDGE_DIR, 'sample-holdout');
    expect(loaded.fixture.holdout).toBe('openlinear-sample-holdout');
    expect(loaded.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(selectPromptKnowledge(loaded.fixture.entries)).toHaveLength(loaded.fixture.entries.length);
  });
});
