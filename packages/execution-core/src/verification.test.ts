import { describe, expect, it } from 'vitest';
import {
  EFFECT_RECOVERY,
  RUN_TRANSITIONS,
  decideRunRecovery,
  canTransition,
} from './run-contract';
import {
  autoDetectChecks,
  canonicalJson,
  checksHashOf,
  describeVerification,
  manifestRequiresVerification,
  parseProjectVerificationSettings,
  parseRepositoryChecksFile,
  resolveVerificationManifest,
  summarizeVerification,
  verificationPublicationDecision,
  type ResolveManifestInput,
  type VerificationCheckResult,
} from './verification';

/** Deterministic stand-in hash (the package has no Node typings; the sidecar injects sha256). */
const sha256 = (text: string) => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    a = Math.imul(a ^ text.charCodeAt(index), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(index), 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(4);
};
const BASE = 'a'.repeat(40);

function input(overrides: Partial<ResolveManifestInput> = {}): ResolveManifestInput {
  return {
    projectSettings: null,
    projectSettingsSha256: null,
    baseCommit: BASE,
    repositoryFile: { text: null, sha256: null },
    autoDetect: () => null,
    hash: sha256,
    now: () => '2026-10-26T00:00:00.000Z',
    ...overrides,
  };
}

function result(status: VerificationCheckResult['status'], required = true): VerificationCheckResult {
  return {
    id: `c-${status}`, name: status, required, status, exitCode: status === 'passed' ? 0 : 1, signal: null, durationMs: 1,
    timedOut: status === 'timed_out', network: 'none', command: 'x', log: { sha256: null, bytes: 0, truncated: false, tail: '', artifact: null }, detail: null,
  };
}

describe('W11a run contract additions', () => {
  it('verifying sits between the agent turn and publication', () => {
    expect(canTransition('running', 'verifying')).toBe(true);
    expect(canTransition('verifying', 'finishing')).toBe(true);
    expect(canTransition('verifying', 'succeeded')).toBe(false);
    expect(canTransition('verifying', 'running')).toBe(false);
    expect(canTransition('finishing', 'verifying')).toBe(false);
    expect(RUN_TRANSITIONS.verifying).toEqual(expect.arrayContaining(['cancelled', 'failed', 'abandoned', 'recovery_required']));
  });

  it('recovers a verifying run by resuming publication (reconcile commit, reuse or re-run checks)', () => {
    expect(decideRunRecovery({ state: 'verifying', controlPlane: 'active', cancelRequested: false, promptEffect: 'confirmed', runtime: 'not-probed' }))
      .toEqual({ action: 'resume-finishing' });
    expect(decideRunRecovery({ state: 'verifying', controlPlane: 'active', cancelRequested: true, promptEffect: 'confirmed', runtime: 'not-probed' }))
      .toEqual({ action: 'cancel' });
    expect(EFFECT_RECOVERY['verify.run']).toMatchObject({ action: 'rerun-verification', redispatchWhenAbsent: true });
    expect(EFFECT_RECOVERY['verification.record'].action).toBe('resend-idempotent');
  });
});

describe('check definitions', () => {
  it('normalizes run strings, argv lists, cwd, timeouts and network', () => {
    const parsed = parseProjectVerificationSettings({
      policy: 'require-pass',
      checks: [
        { name: 'Unit tests', run: 'pnpm test' },
        { id: 'types', name: 'Types', command: ['pnpm', 'run', 'typecheck'], cwd: './apps/web/', timeoutSeconds: 30, network: { allow: ['Registry.Example.com'], registries: true }, required: false },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.policy).toBe('require-pass');
    expect(parsed.value.checks[0]).toEqual({ id: 'unit-tests', name: 'Unit tests', argv: ['/bin/sh', '-c', 'pnpm test'], cwd: '', timeoutMs: 600_000, network: { mode: 'none' }, required: true });
    expect(parsed.value.checks[1]).toMatchObject({ id: 'types', cwd: 'apps/web', timeoutMs: 30_000, network: { mode: 'egress', hosts: ['registry.example.com'], registries: true }, required: false });
    expect(parsed.value.repositoryChecks).toBe(true);
    expect(parsed.value.autoDetect).toBe(false);
  });

  it('round-trips a stored (normalized) value', () => {
    const first = parseProjectVerificationSettings({ checks: [{ name: 'a', run: 'true', network: 'registries' }] });
    if (!first.ok) throw new Error('invalid');
    const again = parseProjectVerificationSettings(JSON.parse(JSON.stringify(first.value)));
    expect(again).toEqual(first);
  });

  it('refuses escapes, duplicates, unknown keys and oversized input', () => {
    const bad = parseProjectVerificationSettings({
      policy: 'sometimes',
      extra: 1,
      checks: [
        { name: 'a', run: 'true', cwd: '../outside' },
        { name: 'b', run: 'true', cwd: '/etc' },
        { name: 'c', run: 'true', command: ['x'] },
        { name: 'd' },
        { name: 'e', run: 'true', timeoutSeconds: 99_999 },
        { name: 'f', run: 'true', network: { allow: ['not a host'] } },
        { name: 'same', run: 'true' },
        { name: 'same', run: 'true' },
        { name: 'g', run: 'a\0b' },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const joined = bad.errors.join('\n');
    for (const fragment of ['policy must be', 'extra is not a known setting', 'checks[0].cwd', 'checks[1].cwd', 'either "run" or "command"', 'checks[3] needs', 'timeoutSeconds', 'invalid host', 'repeats the id', 'checks[8].run']) {
      expect(joined).toContain(fragment);
    }
    expect(parseProjectVerificationSettings({ checks: Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, run: 'true' })) }).ok).toBe(false);
  });

  it('refuses IP addresses in a network allow list (checks and setup name hosts only)', () => {
    for (const host of ['127.0.0.1:4096', '0.0.0.0:5432', '169.254.169.254:80', '10.0.0.5', '127.1', '0x7f.0.0.1']) {
      const parsed = parseProjectVerificationSettings({ checks: [{ name: 'a', run: 'true', network: { allow: [host] } }], setup: [{ name: 's', run: 'true', network: { allow: [host] } }] });
      expect(parsed.ok, host).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.errors.join('\n')).toMatch(/IP address .*use a host name/);
    }
    const named = parseProjectVerificationSettings({ checks: [{ name: 'a', run: 'true', network: { allow: ['registry.example.com:8443', 'v2.cdn.example.io'] } }] });
    expect(named.ok).toBe(true);
  });

  it('repository files: checks only, policy ignored with a warning, invalid JSON reported', () => {
    const parsed = parseRepositoryChecksFile(JSON.stringify({ policy: 'off', checks: [{ name: 'lint', run: 'npm run lint' }] }));
    expect(parsed).toMatchObject({ ok: true, value: [{ id: 'lint' }] });
    if (parsed.ok) expect(parsed.warnings[0]).toContain('"policy" is ignored');
    expect(parseRepositoryChecksFile('{nope')).toMatchObject({ ok: false });
    expect(parseRepositoryChecksFile(JSON.stringify({ checks: [{ name: 'x' }] }))).toMatchObject({ ok: false });
  });

  it('auto-detects only typecheck/test scripts, with an install step when a lockfile exists', () => {
    const pkg = JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc', build: 'next build', lint: 'eslint' } });
    const checks = autoDetectChecks({ packageJson: pkg, lockfiles: { pnpm: true, yarn: false, npm: false, bun: false } });
    expect(checks.map((check) => check.id)).toEqual(['install', 'typecheck', 'test']);
    expect(checks[0]).toMatchObject({ argv: ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts'], network: { mode: 'egress', registries: true } });
    expect(checks[2]).toMatchObject({ argv: ['pnpm', 'run', 'test'], network: { mode: 'none' } });
    expect(autoDetectChecks({ packageJson: JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }), lockfiles: { pnpm: false, yarn: false, npm: true, bun: false } })).toEqual([]);
    expect(autoDetectChecks({ packageJson: null, lockfiles: { pnpm: false, yarn: false, npm: false, bun: false } })).toEqual([]);
  });
});

describe('manifest precedence (sealed before the agent runs)', () => {
  const repoFile = JSON.stringify({ checks: [{ name: 'repo-check', run: 'make check' }] });

  it('project checks win; the repository file is recorded as ignored', () => {
    const manifest = resolveVerificationManifest(input({
      projectSettings: { checks: [{ name: 'project-check', run: 'true' }] },
      projectSettingsSha256: 'p'.repeat(64),
      repositoryFile: { text: repoFile, sha256: sha256(repoFile) },
    }));
    expect(manifest.source).toBe('project');
    expect(manifest.checks.map((check) => check.id)).toEqual(['project-check']);
    expect(manifest.inputs).toEqual([
      expect.objectContaining({ kind: 'project', status: 'used', sha256: 'p'.repeat(64) }),
      expect.objectContaining({ kind: 'repository', status: 'ignored', ref: BASE }),
    ]);
    expect(manifest.checksHash).toBe(checksHashOf(manifest.checks, sha256));
    expect(manifest.policy).toBe('warn');
    expect(manifest.policySource).toBe('project');
  });

  it('falls back to the base-commit repository file, then (only when enabled) auto-detection', () => {
    const fromRepo = resolveVerificationManifest(input({ repositoryFile: { text: repoFile, sha256: sha256(repoFile) } }));
    expect(fromRepo).toMatchObject({ source: 'repository', policySource: 'default', baseCommit: BASE });
    expect(fromRepo.inputs[1]).toMatchObject({ kind: 'repository', status: 'used', sha256: sha256(repoFile) });

    let detected = 0;
    const autoDetect = () => {
      detected += 1;
      return { checks: autoDetectChecks({ packageJson: JSON.stringify({ scripts: { test: 'vitest' } }), lockfiles: { pnpm: false, yarn: false, npm: false, bun: false } }), sha256: 'd'.repeat(64) };
    };
    expect(resolveVerificationManifest(input({ autoDetect })).source).toBe('none');
    expect(detected).toBe(0);
    const auto = resolveVerificationManifest(input({ projectSettings: { autoDetect: true }, autoDetect }));
    expect(auto.source).toBe('auto-detect');
    expect(auto.checks.map((check) => check.id)).toEqual(['test']);
  });

  it('an invalid repository file is a problem, never a silent "no checks"', () => {
    const manifest = resolveVerificationManifest(input({ projectSettings: { autoDetect: true }, repositoryFile: { text: '{"checks": 3}', sha256: 'x'.repeat(64) }, autoDetect: () => ({ checks: [], sha256: null }) }));
    expect(manifest.source).toBe('repository');
    expect(manifest.checks).toEqual([]);
    expect(manifest.problems[0]).toContain('checks must be a list');
    expect(manifestRequiresVerification(manifest)).toBe(true);
  });

  it('policy off disables everything; repositoryChecks:false ignores the file', () => {
    const off = resolveVerificationManifest(input({ projectSettings: { policy: 'off', checks: [{ name: 'a', run: 'true' }] }, repositoryFile: { text: repoFile, sha256: null } }));
    expect(off).toMatchObject({ source: 'none', checks: [], policy: 'off' });
    expect(manifestRequiresVerification(off)).toBe(false);
    const ignored = resolveVerificationManifest(input({ projectSettings: { repositoryChecks: false }, repositoryFile: { text: repoFile, sha256: null } }));
    expect(ignored.source).toBe('none');
    expect(ignored.inputs[1]).toMatchObject({ kind: 'repository', status: 'disabled' });
  });

  it('enters verifying only when there is something to verify (or require-pass must block)', () => {
    expect(manifestRequiresVerification(null)).toBe(false);
    expect(manifestRequiresVerification(resolveVerificationManifest(input()))).toBe(false);
    expect(manifestRequiresVerification(resolveVerificationManifest(input({ projectSettings: { policy: 'require-pass' } })))).toBe(true);
    expect(manifestRequiresVerification(resolveVerificationManifest(input({ repositoryFile: { text: repoFile, sha256: null } })))).toBe(true);
  });

  it('hashes canonically: key order does not change the checks hash', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    const one = resolveVerificationManifest(input({ projectSettings: { checks: [{ name: 'a', run: 'true', required: true }] } }));
    const two = resolveVerificationManifest(input({ projectSettings: { checks: [{ required: true, run: 'true', name: 'a' }] } }));
    expect(one.checksHash).toBe(two.checksHash);
  });
});

describe('results and policy', () => {
  it('summarizes exit-code results; informational checks never fail verification', () => {
    expect(summarizeVerification([])).toBe('skipped');
    expect(summarizeVerification([result('passed'), result('failed', false)])).toBe('passed');
    expect(summarizeVerification([result('passed'), result('timed_out')])).toBe('failed');
    expect(summarizeVerification([result('passed'), result('error')])).toBe('error');
    expect(summarizeVerification([result('failed'), result('error')])).toBe('failed');
  });

  it('applies require-pass | warn | off', () => {
    expect(verificationPublicationDecision('require-pass', 'passed').allowed).toBe(true);
    for (const status of ['failed', 'error', 'skipped'] as const) {
      expect(verificationPublicationDecision('require-pass', status).allowed).toBe(false);
      expect(verificationPublicationDecision('warn', status).allowed).toBe(true);
    }
    expect(verificationPublicationDecision('off', 'skipped')).toMatchObject({ allowed: true });
    expect(verificationPublicationDecision('require-pass', 'skipped').reason).toContain('no checks are configured');
  });

  it('describes a result in one line', () => {
    const sha = 'b'.repeat(40);
    expect(describeVerification({ status: 'failed', commitSha: sha, checks: [result('passed'), result('failed')], detail: null }))
      .toBe('Verification failed on bbbbbbbbbbbb: 1 of 2 required checks failed');
    expect(describeVerification({ status: 'passed', commitSha: sha, checks: [result('passed')], detail: null })).toContain('1/1 required check)');
  });
});
