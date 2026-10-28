import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { EvalManifest } from '../manifest/schema';
import type { LoadedTask } from '../tasks/types';
import { sha256Hex } from '../util/hash';

/**
 * W19b ablation input: a per-suite knowledge fixture — the conventions and
 * procedures a team would have approved for the evaluated repositories —
 * given to the treatment arm as the "## Project knowledge" section.
 *
 *   <knowledge dir>/<fixture>.json   (pinned by sha256 in the manifest)
 *
 * Entries follow the API's rules (kinds, title ≤ 120, body ≤ 4 000) and the
 * control plane's prompt selection (`promptKnowledge`: conventions, then
 * procedures, then notes; ≤ 20 entries and ≤ 8 000 characters of title +
 * body), so the treatment gets what a run of that project would get.
 *
 * Contamination: every entry records the tasks it was derived from. Sealed
 * tasks never feed knowledge (W19: "sealed tasks cannot enter memory"), nor
 * do validation tasks (the same rule as `memoryPromotionAllowed`), and no
 * entry may contain a grader canary.
 */

export const KNOWLEDGE_FIXTURE_SCHEMA_VERSION = 'openlinear.eval.knowledge/v1' as const;
export const DEFAULT_KNOWLEDGE_DIR = fileURLToPath(new URL('../../fixtures/knowledge/', import.meta.url));

/** apps/api knowledge limits (schemas/knowledge.ts, services/knowledge.ts `promptKnowledge`). */
export const KNOWLEDGE_LIMITS = { titleMax: 120, bodyMax: 4000, promptEntries: 20, promptChars: 8000, entriesPerProject: 200 } as const;

export const KnowledgeEntrySchema = z
  .object({
    kind: z.enum(['convention', 'procedure', 'note']),
    title: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.titleMax),
    body: z.string().trim().min(1).max(KNOWLEDGE_LIMITS.bodyMax),
    provenance: z
      .object({
        /** Who wrote or approved it (a person; agents only propose). */
        author: z.string().min(1),
        /** Task ids the entry was learned from (empty = general team knowledge). */
        derivedFrom: z.array(z.string().min(1)).default([]),
      })
      .strict(),
  })
  .strict();

export const KnowledgeFixtureSchema = z
  .object({
    schemaVersion: z.literal(KNOWLEDGE_FIXTURE_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
    /** The holdout (suite name) the fixture was written for. */
    holdout: z.string().min(1),
    description: z.string().default(''),
    /** Newest first within a kind (the API orders by last update). */
    entries: z.array(KnowledgeEntrySchema).min(1).max(KNOWLEDGE_LIMITS.entriesPerProject),
  })
  .strict();

export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;
export type KnowledgeFixture = z.infer<typeof KnowledgeFixtureSchema>;

export interface LoadedKnowledgeFixture {
  name: string;
  path: string;
  /** sha256 of the file bytes (what the manifest pins). */
  checksum: string;
  fixture: KnowledgeFixture;
}

export async function loadKnowledgeFixture(dir: string, name: string): Promise<LoadedKnowledgeFixture> {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`invalid knowledge fixture name ${name}`);
  const path = join(dir, `${name}.json`);
  const bytes = await readFile(path);
  const fixture = KnowledgeFixtureSchema.parse(JSON.parse(bytes.toString('utf8')));
  return { name, path, checksum: sha256Hex(bytes), fixture };
}

/** The entries a run is given, as the control plane selects them (`promptKnowledge`). */
export function selectPromptKnowledge(entries: readonly KnowledgeEntry[]): KnowledgeEntry[] {
  const rank: Record<KnowledgeEntry['kind'], number> = { convention: 0, procedure: 1, note: 2 };
  const ordered = entries.map((entry, index) => ({ entry, index })).sort((a, b) => rank[a.entry.kind] - rank[b.entry.kind] || a.index - b.index);
  const chosen: KnowledgeEntry[] = [];
  let chars = 0;
  for (const { entry } of ordered) {
    if (chosen.length >= KNOWLEDGE_LIMITS.promptEntries) break;
    const size = entry.title.length + entry.body.length;
    if (chars + size > KNOWLEDGE_LIMITS.promptChars) continue;
    chars += size;
    chosen.push(entry);
  }
  return chosen;
}

export interface KnowledgeCheck {
  /** Blocking: the fixture must not be used. */
  problems: string[];
  /** Not blocking, but a report must say so (e.g. in-sample entries). */
  notes: string[];
}

/**
 * Checks a fixture against the manifest that pins it and the loaded tasks
 * (the whole holdout, so sealed tasks outside the manifest count too).
 */
export function checkKnowledgeFixture(input: {
  loaded: LoadedKnowledgeFixture;
  expectedChecksum: string;
  manifest: EvalManifest;
  tasks: readonly LoadedTask[];
  canaries?: readonly string[];
}): KnowledgeCheck {
  const { loaded, manifest } = input;
  const label = `knowledge fixture ${loaded.name}`;
  const problems: string[] = [];
  const notes: string[] = [];
  if (loaded.checksum !== input.expectedChecksum) problems.push(`${label}: sha256 ${loaded.checksum} differs from the manifest's ${input.expectedChecksum} (the manifest pins the exact entries)`);
  const suites = new Set(manifest.suites.map((suite) => suite.name));
  if (!suites.has(loaded.fixture.holdout)) problems.push(`${label}: written for holdout ${loaded.fixture.holdout}, but the manifest runs ${[...suites].join(', ')}`);

  const loadedTasks = new Map(input.tasks.map((task) => [task.spec.id, task]));
  const sealedRefs = new Set(manifest.suites.flatMap((suite) => suite.tasks.filter((task) => task.sealed).map((task) => task.id)));
  const evaluated = new Set(manifest.suites.flatMap((suite) => suite.tasks.map((task) => task.id)));
  const canaries = [...manifest.contamination.canaries, ...(input.canaries ?? [])];
  for (const entry of loaded.fixture.entries) {
    const title = JSON.stringify(entry.title);
    for (const source of entry.provenance.derivedFrom) {
      const task = loadedTasks.get(source);
      if (sealedRefs.has(source) || task?.sealed) {
        problems.push(`${label}: entry ${title} was derived from sealed task ${source} — sealed tasks never feed knowledge (W19)`);
      } else if (task && task.spec.split !== 'development') {
        problems.push(`${label}: entry ${title} was derived from ${task.spec.split} task ${source} — only development tasks may feed knowledge`);
      } else if (evaluated.has(source)) {
        notes.push(`${label}: entry ${title} was derived from ${source}, which this manifest also evaluates — its paired result there is in-sample, not evidence of benefit`);
      }
    }
    for (const canary of canaries) {
      if (entry.title.includes(canary) || entry.body.includes(canary)) problems.push(`${label}: entry ${title} contains grader canary ${canary}`);
    }
  }
  return { problems, notes };
}
