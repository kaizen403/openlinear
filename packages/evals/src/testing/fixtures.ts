import type { Configuration, EvalManifestInput } from '../manifest/schema';
import { sha256Hex } from '../util/hash';

/** Test helpers: a minimal valid manifest and configurations. Not used at run time. */

const H = sha256Hex('none');

export function testConfiguration(id: string, overrides: Partial<Configuration> = {}): Configuration {
  return {
    id,
    label: id,
    harness: 'native',
    transport: 'cli',
    runner: { id: 'codex', binaryVersion: '0.164.0', binarySha256: null, sdkVersion: null, mode: 'real' },
    model: {
      requested: 'gpt-x',
      snapshot: 'gpt-x-2026-09-01',
      provider: 'openai',
      endpoint: null,
      region: null,
      effort: null,
      sampling: { temperature: null, topP: null, seed: null },
      maxOutputTokens: null,
      contextPolicy: null,
      routing: 'fixed',
    },
    assets: { systemContract: H, promptTemplate: H, tools: H, skills: H, mcpConfig: H },
    enhancements: {},
    ...overrides,
  };
}

export function testManifestInput(overrides: Partial<EvalManifestInput> = {}): EvalManifestInput {
  return {
    schemaVersion: 'openlinear.eval.manifest/v1',
    id: 'test-manifest',
    title: 'Test manifest',
    createdAt: '2026-10-26T00:00:00.000Z',
    purpose: 'development',
    track: 'harness-parity',
    repeats: 3,
    suites: [
      {
        id: 'holdout',
        kind: 'private-holdout',
        name: 'holdout',
        version: '1',
        source: { repository: 'local', revision: 'a'.repeat(40) },
        official: false,
        tasks: [
          { id: 't1', checksum: 'b'.repeat(64), category: 'logic' },
          { id: 't2', checksum: 'c'.repeat(64), category: 'parsing' },
        ],
      },
    ],
    hardware: { provider: 'local', os: 'darwin', arch: 'arm64', cpus: 8, memoryMb: 16_384, diskMb: null, resourcePolicy: 'none' },
    concurrency: { maxConcurrentTrials: 2, order: 'randomized-interleaved', seed: 1 },
    toolchain: { node: '22.16.0', git: '2.49.0' },
    configurations: [testConfiguration('a'), testConfiguration('b')],
    sandbox: { provider: 'seatbelt', agentNetwork: 'allowlist', allowedHosts: ['api.openai.com'], verifierNetwork: 'no-network', envPolicy: 'allowlist', privateHome: true },
    budgets: { agentTimeoutMs: 3_000_000, verifierTimeoutMs: 600_000 },
    retries: { infraRetries: 1 },
    prices: [],
    verifier: { revision: 'grader', graderAssets: 'd'.repeat(64), method: 'pristine-checkout' },
    contamination: { sealedHoldoutPresent: false, crossTaskMemoryReset: true, solutionLookup: 'blocked', historySanitized: true },
    analysis: { comparisons: [{ treatment: 'a', baseline: 'b' }] },
    ...overrides,
  };
}
