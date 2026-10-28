import type { Features } from '../../manifest/schema';

/**
 * The three W21 ablations the PRD asks for, each a paired experiment: a
 * baseline and a treatment configuration identical except for `features`,
 * over the same tasks and repeats.
 *
 * - repository-context (W16, ledger context.md): "context benefit
 *   demonstrated with ablation";
 * - project-knowledge (W19b, ledger knowledge.md) and reviewer (W19a, ledger
 *   reviewer.md): "ablations justify extra agents" — net of their cost.
 */

export const ABLATION_NAMES = ['repository-context', 'project-knowledge', 'reviewer'] as const;
export type AblationName = (typeof ABLATION_NAMES)[number];

export interface KnowledgePin {
  fixture: string;
  checksum: string;
}

export interface AblationDefinition {
  name: AblationName;
  title: string;
  /** PRD acceptance item and the ledger of the feature under test. */
  prd: string;
  question: string;
  /** Configuration ids of the two arms. */
  baselineId: string;
  treatmentId: string;
  treatmentLabel: string;
  /** The treatment's features (the knowledge arm needs the pinned fixture). */
  features(knowledge: KnowledgePin | null): Features;
}

/** The sidecar's default section budget (OPENLINEAR_REPO_CONTEXT_MAX_CHARS unset) and file count. */
export const REPOSITORY_CONTEXT_DEFAULTS = { maxChars: 6000, maxFiles: 6 } as const;

export const ABLATIONS: Readonly<Record<AblationName, AblationDefinition>> = {
  'repository-context': {
    name: 'repository-context',
    title: 'W16b repository context: with vs without the "Repository context" prompt section',
    prd: 'PRD W16 "context benefit demonstrated with ablation" — docs/reports/revamp-2026-10-26/context.md',
    question: 'Does the related-files section (indexed at the task\'s base commit) raise single-attempt success, and at what token cost?',
    baselineId: 'baseline',
    treatmentId: 'repo-context',
    treatmentLabel: 'with the W16b Repository context section',
    features: () => ({ repositoryContext: { ...REPOSITORY_CONTEXT_DEFAULTS } }),
  },
  'project-knowledge': {
    name: 'project-knowledge',
    title: 'W19b project knowledge: with vs without the "Project knowledge" prompt section',
    prd: 'PRD W19 "ablations justify extra agents" (memory) — docs/reports/revamp-2026-10-26/knowledge.md',
    question: 'Do approved conventions and procedures for the evaluated repositories raise single-attempt success?',
    baselineId: 'baseline',
    treatmentId: 'knowledge',
    treatmentLabel: 'with the W19b Project knowledge section',
    features: (knowledge) => {
      if (!knowledge) throw new Error('the project-knowledge ablation needs a knowledge fixture (name and sha256)');
      return { knowledge: { fixture: knowledge.fixture, checksum: knowledge.checksum } };
    },
  },
  reviewer: {
    name: 'reviewer',
    title: 'W19a reviewer: the run alone vs run + independent review + one follow-up turn',
    prd: 'PRD W19 "ablations justify extra agents" (independent reviewer) — docs/reports/revamp-2026-10-26/reviewer.md',
    question: 'Does a reviewer pass with one follow-up on its blocker/major findings raise success enough to pay for its extra sessions?',
    baselineId: 'baseline',
    treatmentId: 'reviewer',
    treatmentLabel: 'with the W19a reviewer pass and one follow-up turn',
    features: () => ({ reviewer: { followUp: true, maxFindings: 10 } }),
  },
};

export function ablationDefinition(name: string): AblationDefinition {
  if (!(ABLATION_NAMES as readonly string[]).includes(name)) throw new Error(`unknown ablation ${name} (expected ${ABLATION_NAMES.join(', ')})`);
  return ABLATIONS[name as AblationName];
}
