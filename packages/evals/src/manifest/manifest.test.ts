import { describe, expect, it } from 'vitest';
import { testConfiguration, testManifestInput } from '../testing/fixtures';
import { detectDrift, mergeDrift, type ObservedEnvironment } from './drift';
import { assertRunnable, findFloatingRefs, isFloatingModel, isFloatingVersion, ManifestNotFrozenError, resolveManifest, staticModelResolver } from './resolve';
import { EvalManifestSchema, manifestDigest, parseManifest } from './schema';

const env: ObservedEnvironment = { node: '22.16.0', git: '2.49.0', os: 'darwin 25', arch: 'arm64', cpus: 8, memoryMb: 16_384 };

describe('manifest schema', () => {
  it('accepts a complete manifest and fills defaults', () => {
    const manifest = parseManifest(testManifestInput());
    expect(manifest.analysis.bootstrapResamples).toBe(2000);
    expect(manifest.budgets.gradeOnTimeout).toBe(true);
    expect(manifest.retries.keepOriginal).toBe(true);
    expect(manifest.suites[0]?.tasks[0]?.sealed).toBe(false);
  });

  it('enforces the PRD §10 protocol rules', () => {
    const issues = (input: ReturnType<typeof testManifestInput>) => EvalManifestSchema.safeParse(input).error?.issues.map((i) => i.message) ?? [];
    expect(issues(testManifestInput({ purpose: 'release', repeats: 3 }))).toContainEqual(expect.stringContaining('five fresh trials'));
    expect(issues(testManifestInput({ configurations: [testConfiguration('a'), testConfiguration('a')], analysis: {} }))).toContainEqual(expect.stringContaining('duplicate configuration'));
    expect(issues(testManifestInput({ analysis: { comparisons: [{ treatment: 'a', baseline: 'zzz' }] } }))).toContainEqual(expect.stringContaining('unknown configuration zzz'));
    const fake = testConfiguration('a', { runner: { id: 'opencode', binaryVersion: 'replay-1', binarySha256: null, sdkVersion: null, mode: 'fake' } });
    expect(issues(testManifestInput({ configurations: [fake, testConfiguration('b')] }))).toContainEqual(expect.stringContaining('only allowed in smoke'));
    const sealedSuite = testManifestInput().suites.map((suite) => ({ ...suite, tasks: suite.tasks.map((t) => ({ ...t, sealed: true })) }));
    expect(issues(testManifestInput({ suites: sealedSuite, contamination: { sealedHoldoutPresent: true, crossTaskMemoryReset: true, solutionLookup: 'blocked', historySanitized: true } }))).toContainEqual(
      expect.stringContaining('never while tuning'),
    );
    expect(issues(testManifestInput({ track: 'official-fidelity' }))).toContainEqual(expect.stringContaining('published rules'));
    const native = testConfiguration('n', { transport: 'adapter' });
    expect(issues(testManifestInput({ configurations: [native], analysis: {} }))).toContainEqual(expect.stringContaining('cli transport'));
  });

  it('digest ignores retained drift notices but not configuration', () => {
    const a = parseManifest(testManifestInput());
    const withDrift = { ...a, drift: [{ field: '/x', expected: '1', observed: '2', severity: 'warning' as const, detectedAt: '2026-10-26T00:00:00.000Z', note: '' }] };
    expect(manifestDigest(withDrift)).toBe(manifestDigest(a));
    expect(manifestDigest({ ...a, repeats: 4 })).not.toBe(manifestDigest(a));
  });
});

describe('alias resolution and freeze checks', () => {
  it('flags floating models, versions and revisions', () => {
    expect(isFloatingModel('sonnet', 'sonnet')).toBe(true);
    expect(isFloatingModel('gpt-x-latest', 'gpt-x')).toBe(true);
    expect(isFloatingModel('', 'x')).toBe(true);
    expect(isFloatingModel('claude-x-20261001', 'sonnet')).toBe(false);
    expect(isFloatingVersion('latest')).toBe(true);
    expect(isFloatingVersion('^1.2.0')).toBe(true);
    expect(isFloatingVersion('1.x')).toBe(true);
    expect(isFloatingVersion('2.1.310')).toBe(false);
    const manifest = parseManifest(
      testManifestInput({
        suites: testManifestInput().suites.map((s) => ({ ...s, source: { repository: 'r', revision: 'main' } })),
        configurations: [testConfiguration('a', { model: { ...testConfiguration('a').model, requested: 'sonnet', snapshot: 'sonnet' }, runner: { ...testConfiguration('a').runner, binaryVersion: 'latest' } }), testConfiguration('b')],
      }),
    );
    const refs = findFloatingRefs(manifest).map((r) => r.field);
    expect(refs).toEqual(['/suites/0/source/revision', '/configurations/0/model/snapshot', '/configurations/0/runner/binaryVersion']);
    expect(() => assertRunnable(manifest)).toThrow(ManifestNotFrozenError);
    expect(() => assertRunnable({ ...manifest, purpose: 'smoke' })).not.toThrow();
  });

  it('resolves through injected resolvers and records every alias', async () => {
    const draft = parseManifest(
      testManifestInput({
        suites: testManifestInput().suites.map((s) => ({ ...s, source: { repository: 'r', revision: 'v1.0' } })),
        configurations: [testConfiguration('a', { model: { ...testConfiguration('a').model, requested: 'sonnet', snapshot: '' }, runner: { ...testConfiguration('a').runner, binaryVersion: 'latest' } }), testConfiguration('b')],
      }),
    );
    const resolved = await resolveManifest(draft, {
      model: staticModelResolver({ sonnet: 'claude-sonnet-x-20261001' }, 'provider model list 2026-10-26'),
      runner: () => ({ value: '0.164.0', sha256: 'e'.repeat(64), source: 'codex --version' }),
      revision: () => ({ value: 'f'.repeat(40), source: 'git ls-remote' }),
      now: () => new Date('2026-10-26T12:00:00Z'),
    });
    expect(resolved.suites[0]?.source.revision).toBe('f'.repeat(40));
    expect(resolved.configurations[0]?.model.snapshot).toBe('claude-sonnet-x-20261001');
    expect(resolved.configurations[0]?.runner.binaryVersion).toBe('0.164.0');
    expect(resolved.configurations[0]?.runner.binarySha256).toBe('e'.repeat(64));
    expect(resolved.aliases.map((a) => a.field)).toEqual([
      '/suites/0/source/revision',
      '/configurations/0/model/snapshot',
      '/configurations/0/runner/binaryVersion',
      '/configurations/0/runner/binarySha256',
      '/configurations/1/runner/binarySha256',
    ]);
    expect(findFloatingRefs(resolved)).toEqual([]);
  });
});

describe('drift', () => {
  it('reports blocking model/runner/task drift and warnings for the host', () => {
    const manifest = parseManifest(testManifestInput({ prices: [{ provider: 'openai', model: 'gpt-x-2026-09-01', currency: 'USD', inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: null, cacheWritePerMTok: null, asOf: '2026-08-01', source: 'x' }] }));
    const drift = detectDrift({
      manifest,
      environment: { ...env, node: '20.1.0', arch: 'x64', cpus: 4 },
      trials: [
        { configurationId: 'a', trialId: 't-1', model: 'gpt-x-2026-10-15', runnerVersion: '0.164.0' },
        { configurationId: 'a', trialId: 't-2', model: 'gpt-x-2026-10-15', runnerVersion: '0.165.0' },
        { configurationId: 'b', trialId: 't-3', model: null, runnerVersion: null },
      ],
      taskChecksums: new Map([['t1', 'b'.repeat(64)], ['t2', '9'.repeat(64)]]),
      now: new Date('2026-10-26T00:00:00Z'),
    });
    const bySeverity = (s: string) => drift.filter((d) => d.severity === s).map((d) => d.field);
    expect(bySeverity('blocking')).toEqual(['/suites/holdout/tasks/t2/checksum', '/configurations/a/model/snapshot', '/configurations/a/runner/binaryVersion']);
    expect(bySeverity('warning')).toEqual(['/toolchain/node', '/hardware/arch', '/hardware/cpus']);
    expect(bySeverity('info')).toEqual(['/configurations/b/model/snapshot', '/prices/openai/gpt-x-2026-09-01']);
    expect(mergeDrift(drift, drift)).toHaveLength(drift.length);
  });
});
