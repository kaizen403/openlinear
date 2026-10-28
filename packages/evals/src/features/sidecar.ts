import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { FindingEvidence, ReviewSeverity } from './types';

/**
 * The sidecar code the W21 ablation arms reuse, loaded at run time — like
 * `adapter-loader.ts`, so the harness keeps no compile-time dependency on
 * apps/sidecar (other engineers change it) and an arm measures exactly what
 * production runs get:
 *
 * - W16b `repositoryContextFor` + `ContextEngine` (apps/sidecar/src/context);
 * - W19b `projectKnowledgeSection` (apps/sidecar/src/run/service.ts, the
 *   renderer `promptFor` uses);
 * - W19a `buildReviewPrompt` / `parseReviewOutput` / `anchorFindings` /
 *   `safeRepoPath` / `appendReviewAnswer` / `REVIEWER_SYSTEM_CONTRACT` / `MAX_REVIEW_DIFF_CHARS`
 *   (apps/sidecar/src/run/reviewer/contract.ts).
 *
 * Every export is shape-checked on load and every result validated, so a
 * changed sidecar signature fails loudly here instead of silently turning a
 * treatment into the baseline. Run the CLI with `tsx` (TypeScript sources).
 */

/** apps/sidecar/src in this repository (packages/evals/src/features → ../../../../). */
export const DEFAULT_SIDECAR_SRC = fileURLToPath(new URL('../../../../apps/sidecar/src/', import.meta.url));

export interface SidecarKnowledgeEntry {
  kind: string;
  title: string;
  body: string;
}

export interface SidecarContextInput {
  worktreePath: string;
  commitSha: string;
  repositoryKey: string;
  task: { title: string; description: string | null; labels: string[] };
  maxChars: number;
  maxFiles: number;
  /** How long the caller waits for the index (the sidecar's prompt path waits 20 s, then goes without). */
  timeoutMs: number;
  signal?: AbortSignal;
}

const ContextResultSchema = z.object({
  section: z.string().nullable(),
  citations: z.array(z.object({ path: z.string(), startLine: z.number().nullable(), endLine: z.number().nullable() })),
  receipt: z.object({ sha: z.string().nullable(), indexedFiles: z.number(), contentFiles: z.number(), cacheHit: z.boolean(), ms: z.number() }),
  reason: z.string().nullable(),
});
export type SidecarContextResult = z.infer<typeof ContextResultSchema>;

export interface SidecarReviewPromptInput {
  task: { title: string; description: string | null; labels: string[] };
  commit: string;
  baseCommit: string;
  changedFiles: string[];
  diff: string;
  diffTruncated: boolean;
}

const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const satisfies readonly ReviewSeverity[];
const OutputFindingSchema = z.object({
  severity: z.enum(SEVERITIES),
  file: z.string(),
  startLine: z.number(),
  endLine: z.number().optional(),
  quote: z.string(),
  title: z.string(),
  body: z.string(),
});
const ParsedReviewSchema = z.union([
  z.object({ ok: z.literal(true), output: z.object({ summary: z.string(), findings: z.array(OutputFindingSchema) }) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SidecarReviewOutputFinding = z.infer<typeof OutputFindingSchema>;
export type SidecarParsedReview = z.infer<typeof ParsedReviewSchema>;

const EVIDENCE = ['verified', 'relocated', 'unverified'] as const satisfies readonly FindingEvidence[];
const AnchoredSchema = z.array(
  z.object({
    id: z.string(),
    severity: z.enum(SEVERITIES),
    file: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    quote: z.string(),
    title: z.string(),
    body: z.string(),
    evidence: z.enum(EVIDENCE),
    inDiff: z.boolean(),
  }),
);
export type SidecarReviewFinding = z.infer<typeof AnchoredSchema>[number];

export interface SidecarFeatures {
  /** Directory the modules were loaded from. */
  source: string;
  /** A memory-only context engine (no disk cache under the sidecar's app data). */
  createContextEngine(): unknown;
  repositoryContextFor(input: SidecarContextInput, engine: unknown): Promise<SidecarContextResult>;
  projectKnowledgeSection(entries: readonly SidecarKnowledgeEntry[]): string | null;
  reviewerSystemContract: string;
  maxReviewDiffChars: number;
  buildReviewPrompt(input: SidecarReviewPromptInput): string;
  parseReviewOutput(text: string): SidecarParsedReview;
  anchorFindings(commit: string, findings: readonly SidecarReviewOutputFinding[], changedFiles: ReadonlySet<string>, readFile: (path: string) => Promise<string | null>): Promise<SidecarReviewFinding[]>;
  safeRepoPath(path: string): string | null;
  /** One `message.delta` added to the reviewer's answer, capped as the sidecar caps it. */
  appendReviewAnswer(text: string, delta: string): string;
}

export class SidecarFeaturesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SidecarFeaturesError';
  }
}

async function importModule(path: string): Promise<Record<string, unknown>> {
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(path).href);
  } catch (error) {
    throw new SidecarFeaturesError(`could not load ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof mod !== 'object' || mod === null) throw new SidecarFeaturesError(`${path}: not a module`);
  return mod as Record<string, unknown>;
}

type AnyFunction = (...args: unknown[]) => unknown;

function exportedFunction(mod: Record<string, unknown>, file: string, name: string): AnyFunction {
  const value = mod[name];
  if (typeof value !== 'function') throw new SidecarFeaturesError(`${file} no longer exports function ${name}; update packages/evals/src/features/sidecar.ts`);
  return value as AnyFunction;
}

function exportedValue<T extends string | number>(mod: Record<string, unknown>, file: string, name: string, type: 'string' | 'number'): T {
  const value = mod[name];
  if (typeof value !== type) throw new SidecarFeaturesError(`${file} no longer exports ${type} ${name}; update packages/evals/src/features/sidecar.ts`);
  return value as T;
}

/**
 * The sidecar creates its repository storage root on first use
 * (services/repo-storage.ts, `REPOS_DIR`). Point it at a private temporary
 * directory unless the caller chose one, so running the feature code never
 * touches the user's app data.
 */
function isolateSidecarStorage(): void {
  if (process.env.REPOS_DIR) return;
  const dir = mkdtempSync(join(tmpdir(), 'openlinear-eval-sidecar-'));
  process.env.REPOS_DIR = join(dir, 'repos');
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
}

const loaded = new Map<string, Promise<SidecarFeatures>>();

export function loadSidecarFeatures(sidecarSrc: string = DEFAULT_SIDECAR_SRC): Promise<SidecarFeatures> {
  const root = isAbsolute(sidecarSrc) ? sidecarSrc : resolve(process.cwd(), sidecarSrc);
  const cached = loaded.get(root);
  if (cached) return cached;
  const pending = load(root);
  loaded.set(root, pending);
  pending.catch(() => loaded.delete(root));
  return pending;
}

async function load(root: string): Promise<SidecarFeatures> {
  isolateSidecarStorage();
  const contextFile = join(root, 'context', 'index.ts');
  const serviceFile = join(root, 'run', 'service.ts');
  const reviewerFile = join(root, 'run', 'reviewer', 'contract.ts');
  const context = await importModule(contextFile);
  const service = await importModule(serviceFile);
  const reviewer = await importModule(reviewerFile);

  const ContextEngine = context.ContextEngine;
  if (typeof ContextEngine !== 'function') throw new SidecarFeaturesError(`${contextFile} no longer exports class ContextEngine`);
  const engineClass = ContextEngine as new (options: { cache: null }) => unknown;
  const repositoryContextFor = exportedFunction(context, contextFile, 'repositoryContextFor');
  const projectKnowledgeSection = exportedFunction(service, serviceFile, 'projectKnowledgeSection');
  const buildReviewPrompt = exportedFunction(reviewer, reviewerFile, 'buildReviewPrompt');
  const parseReviewOutput = exportedFunction(reviewer, reviewerFile, 'parseReviewOutput');
  const anchorFindings = exportedFunction(reviewer, reviewerFile, 'anchorFindings');
  const safeRepoPath = exportedFunction(reviewer, reviewerFile, 'safeRepoPath');
  const appendReviewAnswer = exportedFunction(reviewer, reviewerFile, 'appendReviewAnswer');
  const reviewerSystemContract = exportedValue<string>(reviewer, reviewerFile, 'REVIEWER_SYSTEM_CONTRACT', 'string');
  const maxReviewDiffChars = exportedValue<number>(reviewer, reviewerFile, 'MAX_REVIEW_DIFF_CHARS', 'number');

  const checked = <T>(schema: z.ZodType<T>, value: unknown, what: string): T => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new SidecarFeaturesError(`${what} returned an unexpected shape (${parsed.error.issues[0]?.path.join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? 'invalid'})`);
    return parsed.data;
  };

  return {
    source: root,
    createContextEngine: () => new engineClass({ cache: null }),
    repositoryContextFor: async (input, engine) => checked(ContextResultSchema, await repositoryContextFor({ ...input, engine }), 'repositoryContextFor'),
    projectKnowledgeSection: (entries) => checked(z.string().nullable(), projectKnowledgeSection(entries), 'projectKnowledgeSection'),
    reviewerSystemContract,
    maxReviewDiffChars,
    buildReviewPrompt: (input) => checked(z.string(), buildReviewPrompt(input), 'buildReviewPrompt'),
    parseReviewOutput: (text) => checked(ParsedReviewSchema, parseReviewOutput(text), 'parseReviewOutput'),
    anchorFindings: async (commit, findings, changedFiles, readFile) => checked(AnchoredSchema, await anchorFindings(commit, findings, changedFiles, readFile), 'anchorFindings'),
    safeRepoPath: (path) => checked(z.string().nullable(), safeRepoPath(path), 'safeRepoPath'),
    appendReviewAnswer: (text, delta) => checked(z.string(), appendReviewAnswer(text, delta), 'appendReviewAnswer'),
  };
}
