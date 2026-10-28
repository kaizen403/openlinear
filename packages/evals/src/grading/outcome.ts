import type { GradeResult } from './verifier';
import type { SafetyFinding } from './safety';

/**
 * How the agent phase ended, as observed by the harness (before grading).
 * - completed: the runner ended its turn normally;
 * - timeout: the wall-clock budget elapsed (harness watchdog);
 * - budget: a turn/token/USD cap or the context window stopped it;
 * - refused: the model declined the task (safety refusal);
 * - agent-error: the runner/agent failed on its own (non-zero exit, EOF);
 * - infra: the platform failed (sandbox, runner unavailable, provider 5xx/429/auth);
 * - cancelled: the harness itself cancelled the trial.
 */
export type Termination = 'completed' | 'timeout' | 'budget' | 'refused' | 'agent-error' | 'infra' | 'cancelled';

/**
 * Result classes reported per trial. `pass` is the only success. Every
 * other class stays in the primary (intent-to-run) denominator as a failure;
 * `infra` is additionally reported on its own and may be rerun under a
 * predeclared rule (adjudicated view).
 */
export type Outcome = 'pass' | 'fail' | 'timeout' | 'infra' | 'refusal' | 'safety';

export const OUTCOMES: readonly Outcome[] = ['pass', 'fail', 'timeout', 'infra', 'refusal', 'safety'];

export interface Classification {
  outcome: Outcome;
  success: boolean;
  reason: string;
  /** Whether the verifier result is a valid measurement of the agent (Harbor's `reward_valid` notion). */
  gradeValid: boolean;
}

export function classifyOutcome(input: {
  termination: Termination;
  terminationDetail?: string;
  grade: GradeResult | null;
  safety: readonly SafetyFinding[];
  gradeOnTimeout: boolean;
}): Classification {
  const { termination, grade } = input;
  const detail = input.terminationDetail ? `: ${input.terminationDetail}` : '';
  if (input.safety.length > 0) {
    return { outcome: 'safety', success: false, reason: input.safety.map((f) => `${f.kind} ${f.detail}`).join('; '), gradeValid: false };
  }
  if (termination === 'infra' || termination === 'cancelled') {
    return { outcome: 'infra', success: false, reason: `${termination}${detail}`, gradeValid: false };
  }
  if (grade === null || grade.status === 'error') {
    return { outcome: 'infra', success: false, reason: `verifier ${grade ? grade.reason : 'not run'}`, gradeValid: false };
  }
  const passed = grade.status === 'pass';
  if (termination === 'timeout' || termination === 'budget') {
    if (passed && input.gradeOnTimeout) return { outcome: 'pass', success: true, reason: `pass (partial patch graded after ${termination}${detail})`, gradeValid: true };
    return { outcome: 'timeout', success: false, reason: `${termination}${detail}`, gradeValid: true };
  }
  if (termination === 'refused') {
    if (passed) return { outcome: 'pass', success: true, reason: `pass despite refusal${detail}`, gradeValid: true };
    return { outcome: 'refusal', success: false, reason: `refused${detail}`, gradeValid: true };
  }
  if (passed) return { outcome: 'pass', success: true, reason: 'pass', gradeValid: true };
  return { outcome: 'fail', success: false, reason: `${grade.reason}${termination === 'agent-error' ? ` (agent error${detail})` : ''}`, gradeValid: true };
}
