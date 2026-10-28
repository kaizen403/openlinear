import { describe, expect, it } from 'vitest';
import {
  SETUP_LIMITS,
  checksHashOf,
  describeSetupFailure,
  describeSetupStep,
  parseProjectVerificationSettings,
  parseSetupSteps,
  resolveSetupPlan,
  setupFailureOutcome,
  setupStepHash,
  type VerificationCheckResult,
} from './verification';

/** Deterministic stand-in hash (the package has no Node typings; callers inject sha256). */
const hash = (text: string) => {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < text.length; index += 1) {
    a = Math.imul(a ^ text.charCodeAt(index), 0x01000193) >>> 0;
    b = Math.imul(b ^ text.charCodeAt(index), 0x5bd1e995) >>> 0;
  }
  return (a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')).repeat(4);
};

function result(overrides: Partial<VerificationCheckResult> = {}): VerificationCheckResult {
  return {
    id: 'install', name: 'install', required: true, status: 'failed', exitCode: 1, signal: null, durationMs: 4_200, timedOut: false,
    network: 'egress', command: 'pnpm install --frozen-lockfile', log: { sha256: null, bytes: 0, truncated: false, tail: '', artifact: null }, detail: null,
    ...overrides,
  };
}

describe('W16a setup steps in the project settings', () => {
  it('parses setup with the check rules: run/command, cwd, timeout, network only when declared, required by default', () => {
    const parsed = parseProjectVerificationSettings({
      policy: 'off',
      setup: [
        { name: 'install', run: 'pnpm install --frozen-lockfile', network: 'registries', timeoutSeconds: 900 },
        { id: 'db', name: 'Prepare database', command: ['pnpm', 'db:generate'], cwd: './packages/db/', required: false },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.policy).toBe('off');
    expect(parsed.value.checks).toEqual([]);
    expect(parsed.value.setup[0]).toEqual({
      id: 'install', name: 'install', argv: ['/bin/sh', '-c', 'pnpm install --frozen-lockfile'], cwd: '', timeoutMs: 900_000,
      network: { mode: 'egress', hosts: [], registries: true }, required: true,
    });
    expect(parsed.value.setup[1]).toMatchObject({ id: 'db', argv: ['pnpm', 'db:generate'], cwd: 'packages/db', network: { mode: 'none' }, required: false, timeoutMs: 600_000 });
  });

  it('defaults to no setup and round-trips a stored (normalized) value', () => {
    const empty = parseProjectVerificationSettings({});
    expect(empty).toMatchObject({ ok: true, value: { setup: [] } });
    const first = parseProjectVerificationSettings({ checks: [{ name: 'test', run: 'pnpm test' }], setup: [{ name: 'install', run: 'pnpm i', network: { allow: ['Files.Example.com'] } }] });
    if (!first.ok) throw new Error('invalid');
    expect(parseProjectVerificationSettings(JSON.parse(JSON.stringify(first.value)))).toEqual(first);
    expect(parseSetupSteps(JSON.parse(JSON.stringify(first.value.setup)))).toEqual({ ok: true, value: first.value.setup, warnings: [] });
  });

  it('refuses invalid steps with setup[i] paths, duplicate ids and more than the step limit', () => {
    const bad = parseProjectVerificationSettings({
      setup: [
        { name: 'escape', run: 'true', cwd: '../..' },
        { name: 'both', run: 'true', command: ['true'] },
        { name: 'slow', run: 'true', timeoutSeconds: 0 },
        { name: 'net', run: 'true', network: 'everything' },
        { name: 'same', run: 'true' },
        { name: 'same', run: 'true' },
        { name: 'x', run: 'true', shell: 'zsh' },
      ],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    const joined = bad.errors.join('\n');
    for (const fragment of ['setup[0].cwd must stay inside the checkout', 'setup[1] must set either', 'setup[2].timeoutSeconds', 'setup[3].network', 'setup[5] repeats the id "same"', 'setup[6].shell is not a known setting']) {
      expect(joined).toContain(fragment);
    }
    expect(parseProjectVerificationSettings({ setup: 'pnpm install' })).toEqual({ ok: false, errors: ['setup must be a list'] });
    const tooMany = parseProjectVerificationSettings({ setup: Array.from({ length: SETUP_LIMITS.maxSteps + 1 }, (_, i) => ({ name: `s${i}`, run: 'true' })) });
    expect(tooMany).toEqual({ ok: false, errors: [`at most ${SETUP_LIMITS.maxSteps} setup steps are allowed`] });
    expect(parseProjectVerificationSettings({ setup: Array.from({ length: SETUP_LIMITS.maxSteps }, (_, i) => ({ name: `s${i}`, run: 'true' })) }).ok).toBe(true);
  });
});

describe('W16a sealed setup plan', () => {
  it('reads only the setup key of the sealed settings; nothing configured = no steps', () => {
    expect(resolveSetupPlan(null, hash)).toEqual({ steps: [], setupHash: checksHashOf([], hash), problems: [] });
    expect(resolveSetupPlan({ policy: 'warn' }, hash).steps).toEqual([]);
    // A problem elsewhere in the settings (verification's concern) does not drop the setup.
    const plan = resolveSetupPlan({ policy: 'sometimes', setup: [{ name: 'install', run: 'pnpm i' }] }, hash);
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((step) => step.id)).toEqual(['install']);
    expect(plan.setupHash).toBe(checksHashOf(plan.steps, hash));
  });

  it('an unreadable setup list is a problem, never "no setup"', () => {
    const plan = resolveSetupPlan({ setup: [{ name: 'install' }] }, hash);
    expect(plan.steps).toEqual([]);
    expect(plan.problems.join('\n')).toContain('setup[0] needs "run"');
  });

  it('a step is identified by what it does (command, directory, network), not by its name or timeout', () => {
    const parse = (step: Record<string, unknown>) => {
      const parsed = parseSetupSteps([step]);
      if (!parsed.ok || !parsed.value[0]) throw new Error('invalid');
      return parsed.value[0];
    };
    const base = setupStepHash(parse({ name: 'install', run: 'pnpm i' }), hash);
    expect(setupStepHash(parse({ name: 'Install deps', run: 'pnpm i', timeoutSeconds: 30, required: false }), hash)).toBe(base);
    expect(setupStepHash(parse({ name: 'install', run: 'pnpm i --frozen-lockfile' }), hash)).not.toBe(base);
    expect(setupStepHash(parse({ name: 'install', run: 'pnpm i', cwd: 'web' }), hash)).not.toBe(base);
    expect(setupStepHash(parse({ name: 'install', run: 'pnpm i', network: 'registries' }), hash)).not.toBe(base);
  });
});

describe('W16a setup outcomes', () => {
  it('describes failures for the run outcome and each step for the log', () => {
    expect(setupFailureOutcome(result())).toBe('Setup failed: install exited 1');
    expect(describeSetupFailure(result({ status: 'timed_out', exitCode: null, signal: 'SIGTERM', detail: 'timed out after 600 s' }))).toBe('install timed out after 600 s');
    expect(describeSetupFailure(result({ status: 'failed', exitCode: null, signal: 'SIGKILL' }))).toBe('install was terminated by SIGKILL');
    expect(describeSetupFailure(result({ status: 'error', exitCode: null, detail: 'command not found inside the sandbox: pnpm' })))
      .toBe('install could not run: command not found inside the sandbox: pnpm');
    expect(describeSetupStep(result({ status: 'passed', exitCode: 0, durationMs: 41_200 }))).toBe('Setup step "install" passed (exit 0 · 41.2 s)');
    expect(describeSetupStep(result({ required: false }))).toBe('Setup step "install" (optional) exited 1 (4.2 s)');
  });
});
