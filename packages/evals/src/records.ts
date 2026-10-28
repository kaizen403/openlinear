import type { FeatureReceipt } from './features/types';
import type { Outcome, Termination } from './grading/outcome';
import type { SafetyFinding } from './grading/safety';
import type { GradeResult } from './grading/verifier';
import type { UsageRecord } from './usage/cost';

export const TRIAL_SCHEMA_VERSION = 'openlinear.eval.trial/v1' as const;

/**
 * One trial: one fresh, independent first attempt of one task by one
 * configuration. Infra reruns create a new record (attempt + 1) and mark the
 * original `supersededBy`; originals are never deleted.
 */
export interface TrialRecord {
  schemaVersion: typeof TRIAL_SCHEMA_VERSION;
  trialId: string;
  /** configuration/task/repeat — identical across infra reruns of the same slot. */
  slotId: string;
  attempt: number;
  supersededBy: string | null;
  /** Position in the randomized interleaved schedule. */
  order: number;
  manifestId: string;
  manifestDigest: string;
  configurationId: string;
  harness: 'openlinear' | 'native';
  transport: 'adapter' | 'api' | 'cli';
  runnerId: string;
  runnerMode: 'real' | 'fake';
  suiteId: string;
  taskId: string;
  taskChecksum: string;
  category: string;
  cluster: string;
  sealed: boolean;
  /** Sealed holdout trials can never feed memory or promotion (W19). */
  memoryPromotionAllowed: boolean;
  repeat: number;
  termination: Termination;
  terminationDetail: string;
  grade: GradeResult | null;
  safety: SafetyFinding[];
  outcome: Outcome;
  success: boolean;
  reason: string;
  gradeValid: boolean;
  usage: UsageRecord;
  timings: {
    setupMs: number;
    agentMs: number;
    captureMs: number;
    gradeMs: number;
    /** Trial start → patch captured (what a user waits for); censored trials included at their stop time. */
    taskToArtifactMs: number;
    firstActionMs: number | null;
  };
  observedModel: string | null;
  observedRunnerVersion: string | null;
  invocation: { command: string; args: string[]; fake: boolean } | null;
  patch: { sha256: string; bytes: number; changedPaths: string[] };
  /** Directory (relative to the run output) holding trajectory.json, patch.diff, logs.txt, grade.json, record.json. */
  artifactsDir: string;
  startedAt: string;
  finishedAt: string;
  /** W21: what the configuration's features applied (prompt sections, reviewer, per-session usage); null without features or in a replay. */
  features?: FeatureReceipt | null;
}

export class SealedPromotionError extends Error {
  constructor(trialId: string) {
    super(`trial ${trialId} belongs to the sealed holdout; its trajectory, patch and findings must not be promoted into memory or used for tuning`);
    this.name = 'SealedPromotionError';
  }
}

/** Guard for any consumer that would learn from trial artifacts (memory promotion, prompt tuning). */
export function assertPromotionAllowed(record: Pick<TrialRecord, 'trialId' | 'sealed' | 'memoryPromotionAllowed'>): void {
  if (record.sealed || !record.memoryPromotionAllowed) throw new SealedPromotionError(record.trialId);
}

/** Intent-to-run view: the first attempt of every slot (infra failures stay failures). */
export function intentToRunView(records: readonly TrialRecord[]): TrialRecord[] {
  return records.filter((record) => record.attempt === 1);
}

/** Adjudicated view: the last attempt of every slot after the predeclared infra-rerun rule. */
export function adjudicatedView(records: readonly TrialRecord[]): TrialRecord[] {
  return records.filter((record) => record.supersededBy === null);
}
