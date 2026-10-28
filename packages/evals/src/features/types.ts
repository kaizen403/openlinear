import type { TokenUsage } from '@openlinear/execution-core';
import type { Termination } from '../grading/outcome';
import type { Configuration } from '../manifest/schema';
import type { CostBasis } from '../usage/cost';

/**
 * W21 ablations: the run-engine features a configuration can enable
 * (`configuration.features`) and the receipt each trial keeps of what was
 * actually applied — so a report can tell "the treatment got the section"
 * from "the treatment ran as the baseline".
 */

export const FEATURE_NAMES = ['repositoryContext', 'knowledge', 'reviewer'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** One agent session of a trial: the run itself, the reviewer, the follow-up turn. */
export type TrialPhase = 'run' | 'review' | 'follow-up';

export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';
export type FindingEvidence = 'verified' | 'relocated' | 'unverified';

/** Features a configuration enables, in a fixed order. */
export function enabledFeatures(config: Pick<Configuration, 'features'>): FeatureName[] {
  const features = config.features;
  if (!features) return [];
  return FEATURE_NAMES.filter((name) => features[name] !== undefined);
}

/** Agent sessions a trial of this configuration can start (each is capped separately by the runner). */
export function sessionsPerTrial(config: Pick<Configuration, 'features'>): number {
  const reviewer = config.features?.reviewer;
  if (!reviewer) return 1;
  return reviewer.followUp ? 3 : 2;
}

export interface PhaseReceipt {
  phase: TrialPhase;
  termination: Termination;
  agentMs: number;
  costUsd: number | null;
  costBasis: CostBasis;
  tokens: TokenUsage | null;
}

export interface FeatureReceipt {
  enabled: FeatureName[];
  repositoryContext?: {
    /** The section was added to the prompt. */
    section: boolean;
    chars: number;
    /** Files the section shows (excerpts, then listed by path), in prompt order. */
    citations: string[];
    commit: string | null;
    indexedFiles: number;
    ms: number;
    /** Why there is no section (null when there is one). */
    reason: string | null;
  };
  knowledge?: {
    fixture: string;
    checksum: string;
    /** Entries given to the agent, in prompt order. */
    entries: Array<{ kind: string; title: string }>;
    chars: number;
  };
  reviewer?: {
    status: 'completed' | 'failed' | 'skipped';
    /** Why the review failed or was skipped (null when it completed). */
    reason: string | null;
    /** The commit the reviewer saw (the agent's work, committed in a disposable clone). */
    commit: string | null;
    findings: Array<{ severity: ReviewSeverity; file: string; startLine: number; endLine: number; title: string; evidence: FindingEvidence; inDiff: boolean }>;
    /** Blocker/major findings handed to the follow-up (≤ maxFindings). */
    actionable: number;
    followUp: 'ran' | 'not-needed' | 'disabled' | 'skipped';
  };
  /** Every agent session of the trial; the trial's usage is their sum. */
  phases: PhaseReceipt[];
}
