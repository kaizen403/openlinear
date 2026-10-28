import type { Configuration, EvalManifest } from '../manifest/schema';
import type { FeatureSupport } from '../runners/types';
import { enabledFeatures, type FeatureName } from './types';

/**
 * Which runner path can apply which feature, known from the manifest alone
 * so a plan refuses before anything runs (the harness re-checks the runner
 * instances it is given). Never run the baseline as the treatment: a
 * feature a path cannot apply is a problem, not a silent no-op.
 *
 * - openlinear/adapter: the harness writes the prompt and drives every
 *   session through the runner contract → all three features.
 * - native/cli: the CLI gets the harness's prompt → prompt sections; no
 *   reviewer (no deny-policy session / follow-up turn through a contract).
 * - openlinear/api: the sidecar builds the prompt from the task snapshot
 *   (repository context follows its OPENLINEAR_REPO_CONTEXT setting,
 *   knowledge comes from the project) → nothing per trial.
 */

export function staticFeatureSupport(config: Pick<Configuration, 'harness' | 'transport'>): FeatureSupport {
  if (config.harness === 'native') return { promptSections: true, reviewPhases: false };
  if (config.transport === 'adapter') return { promptSections: true, reviewPhases: true };
  return { promptSections: false, reviewPhases: false };
}

export function supports(support: FeatureSupport | undefined, feature: FeatureName): boolean {
  if (!support) return false;
  return feature === 'reviewer' ? support.reviewPhases : support.promptSections;
}

const WHY: Record<string, string> = {
  api: 'the sidecar builds the prompt from the task snapshot (repository context follows its OPENLINEAR_REPO_CONTEXT setting; knowledge comes from the project), so nothing can be applied per trial',
  native: 'a reviewer pass needs a separate deny-policy session and a follow-up turn through the runner contract, which the native CLI path does not have',
};

/** Blocking problems: features a configuration enables that its runner path cannot apply. */
export function featureProblems(manifest: EvalManifest): string[] {
  const problems: string[] = [];
  for (const config of manifest.configurations) {
    const support = staticFeatureSupport(config);
    for (const feature of enabledFeatures(config)) {
      if (supports(support, feature)) continue;
      const why = config.transport === 'api' ? WHY.api : WHY.native;
      problems.push(`feature unsupported: ${config.id} enables ${feature} on ${config.harness}/${config.transport}, but ${why} — use harness openlinear with transport adapter`);
    }
  }
  return problems;
}
