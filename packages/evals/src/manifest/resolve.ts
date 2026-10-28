import { baseEnv, runCommand } from '../util/proc';
import { type AliasResolution, type EvalManifest, EvalManifestSchema } from './schema';

/**
 * Alias resolution and freeze checks. Resolution is explicit and injected:
 * this module never contacts a provider. A funded run supplies resolvers that
 * read pinned facts (provider model list, installed binary versions, `git
 * ls-remote`) and every resolution is recorded in `manifest.aliases`.
 */

export interface Resolved {
  value: string;
  source: string;
}

export interface ManifestResolvers {
  /** Model alias → immutable snapshot id (e.g. a provider's dated model id). */
  model?: (requested: string, provider: string) => Promise<Resolved | null> | Resolved | null;
  /** Runner id → exact installed version (and optional artifact checksum). */
  runner?: (runnerId: string, declared: string) => Promise<(Resolved & { sha256?: string | null }) | null> | (Resolved & { sha256?: string | null }) | null;
  /** Repository + ref (tag/branch) → full commit SHA. */
  revision?: (repository: string, ref: string) => Promise<Resolved | null> | Resolved | null;
  now?: () => Date;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const FLOATING_VERSION = /^(latest|stable|next|nightly|\*|x)$|^[\^~]|(^|\.)x($|\.)/i;
/** Well-known floating model names; anything ending in `-latest` is floating too. */
const FLOATING_MODELS = new Set(['sonnet', 'opus', 'haiku', 'fable', 'default', 'best', 'auto', 'latest']);

export function isFloatingModel(snapshot: string, requested: string): boolean {
  if (!snapshot) return true;
  const lower = snapshot.toLowerCase();
  if (FLOATING_MODELS.has(lower) || lower.endsWith('-latest') || lower.endsWith(':latest')) return true;
  return snapshot === requested && FLOATING_MODELS.has(requested.toLowerCase());
}

export function isFloatingVersion(version: string): boolean {
  return FLOATING_VERSION.test(version.trim());
}

export interface FloatingRef {
  field: string;
  value: string;
  reason: string;
}

/** Everything that still prevents the manifest from being a frozen, reproducible configuration. */
export function findFloatingRefs(manifest: EvalManifest): FloatingRef[] {
  const out: FloatingRef[] = [];
  manifest.suites.forEach((suite, s) => {
    if (!FULL_SHA.test(suite.source.revision)) {
      out.push({ field: `/suites/${s}/source/revision`, value: suite.source.revision, reason: 'not a full commit SHA' });
    }
  });
  manifest.configurations.forEach((config, c) => {
    const base = `/configurations/${c}`;
    if (isFloatingModel(config.model.snapshot, config.model.requested)) {
      out.push({ field: `${base}/model/snapshot`, value: config.model.snapshot || '(empty)', reason: 'model alias not resolved to a snapshot' });
    }
    if (isFloatingVersion(config.runner.binaryVersion)) {
      out.push({ field: `${base}/runner/binaryVersion`, value: config.runner.binaryVersion, reason: 'runner version is a floating reference' });
    }
    if (config.runner.mode === 'real' && manifest.purpose === 'release' && config.runner.binarySha256 === null) {
      out.push({ field: `${base}/runner/binarySha256`, value: '(null)', reason: 'release runs need the installed artifact checksum' });
    }
  });
  const harbor = manifest.toolchain.harbor;
  if (harbor && !FULL_SHA.test(harbor.revision)) {
    out.push({ field: '/toolchain/harbor/revision', value: harbor.revision, reason: 'not a full commit SHA' });
  }
  if (harbor && isFloatingVersion(harbor.version)) {
    out.push({ field: '/toolchain/harbor/version', value: harbor.version, reason: 'Harbor version is a floating reference' });
  }
  return out;
}

export class ManifestNotFrozenError extends Error {
  constructor(readonly refs: FloatingRef[]) {
    super(`Manifest has ${refs.length} floating reference(s): ${refs.map((ref) => `${ref.field} (${ref.reason})`).join('; ')}`);
    this.name = 'ManifestNotFrozenError';
  }
}

/** Scored (non-smoke) runs refuse a manifest with floating references. */
export function assertRunnable(manifest: EvalManifest): void {
  if (manifest.purpose === 'smoke') return;
  const refs = findFloatingRefs(manifest);
  if (refs.length > 0) throw new ManifestNotFrozenError(refs);
}

/**
 * Applies the resolvers to every floating reference and records each change.
 * Unresolvable references are left as they are (and still reported by
 * `findFloatingRefs`).
 */
export async function resolveManifest(input: EvalManifest, resolvers: ManifestResolvers): Promise<EvalManifest> {
  const manifest: EvalManifest = structuredClone(input);
  const now = (resolvers.now ?? (() => new Date()))().toISOString();
  const aliases: AliasResolution[] = [...manifest.aliases];
  const record = (field: string, requested: string, resolved: Resolved) => {
    aliases.push({ field, requested, resolved: resolved.value, source: resolved.source, resolvedAt: now });
  };

  for (const [s, suite] of manifest.suites.entries()) {
    if (FULL_SHA.test(suite.source.revision) || !resolvers.revision) continue;
    const resolved = await resolvers.revision(suite.source.repository, suite.source.revision);
    if (resolved && FULL_SHA.test(resolved.value)) {
      record(`/suites/${s}/source/revision`, suite.source.revision, resolved);
      suite.source.revision = resolved.value;
    }
  }

  for (const [c, config] of manifest.configurations.entries()) {
    if (isFloatingModel(config.model.snapshot, config.model.requested) && resolvers.model) {
      const resolved = await resolvers.model(config.model.requested, config.model.provider);
      if (resolved && !isFloatingModel(resolved.value, config.model.requested)) {
        record(`/configurations/${c}/model/snapshot`, config.model.snapshot || config.model.requested, resolved);
        config.model.snapshot = resolved.value;
      }
    }
    if (resolvers.runner && (isFloatingVersion(config.runner.binaryVersion) || config.runner.binarySha256 === null)) {
      const resolved = await resolvers.runner(config.runner.id, config.runner.binaryVersion);
      if (resolved && !isFloatingVersion(resolved.value)) {
        if (resolved.value !== config.runner.binaryVersion) {
          record(`/configurations/${c}/runner/binaryVersion`, config.runner.binaryVersion, resolved);
          config.runner.binaryVersion = resolved.value;
        }
        if (resolved.sha256 && config.runner.binarySha256 === null) {
          record(`/configurations/${c}/runner/binarySha256`, '(null)', { value: resolved.sha256, source: resolved.source });
          config.runner.binarySha256 = resolved.sha256;
        }
      }
    }
  }

  manifest.aliases = aliases;
  return EvalManifestSchema.parse(manifest);
}

/** Static alias table resolver (e.g. a table copied from a provider's dated model list). */
export function staticModelResolver(table: Record<string, string>, source: string): NonNullable<ManifestResolvers['model']> {
  return (requested) => {
    const value = table[requested];
    return value ? { value, source } : null;
  };
}

const VERSION_COMMANDS: Record<string, { binary: string; args: string[] }> = {
  'claude-code': { binary: 'claude', args: ['--version'] },
  codex: { binary: 'codex', args: ['--version'] },
  opencode: { binary: 'opencode', args: ['--version'] },
};

/**
 * Resolves a runner's version by running `<binary> --version` locally. This
 * never performs inference (it is the same probe the sidecar health check uses).
 */
export async function probeRunnerVersion(runnerId: string, binaryOverride?: string): Promise<Resolved | null> {
  const spec = VERSION_COMMANDS[runnerId];
  if (!spec) return null;
  const result = await runCommand(binaryOverride ?? spec.binary, spec.args, {
    cwd: process.cwd(),
    env: baseEnv({ HOME: process.env.HOME ?? '/tmp' }),
    timeoutMs: 15_000,
  });
  if (result.code !== 0) return null;
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(result.stdout);
  if (!match?.[1]) return null;
  return { value: match[1], source: `${binaryOverride ?? spec.binary} ${spec.args.join(' ')}` };
}
