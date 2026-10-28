import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { REVIEW_SEVERITIES } from './contract';

/**
 * W19a: reviews of a task on this device, one owner-only JSON file per task
 * (`<root>/<sha256(taskId)>.json`, newest first, at most
 * MAX_REVIEWS_PER_TASK). Written atomically (temp file + rename). A file
 * that does not parse is treated as empty (the reviews are advisory and can
 * be re-run); it is never interpreted.
 */

export const MAX_REVIEWS_PER_TASK = 10;

const findingRecordSchema = z.object({
  id: z.string(),
  severity: z.enum(REVIEW_SEVERITIES),
  file: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  quote: z.string(),
  title: z.string(),
  body: z.string(),
  evidence: z.enum(['verified', 'relocated', 'unverified']),
  inDiff: z.boolean(),
});

export const reviewRecordSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  runId: z.string(),
  userId: z.string(),
  runner: z.string(),
  commit: z.string(),
  baseCommit: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  summary: z.string(),
  findings: z.array(findingRecordSchema),
  /** Findings the reviewer reported that could not be used (bad path), counted. */
  dropped: z.number().int().min(0),
  diffTruncated: z.boolean(),
  usage: z.object({ usd: z.number(), inputTokens: z.number(), outputTokens: z.number() }),
  error: z.string().nullable(),
  /** The sidecar process that ran it (a `running` review of another boot was interrupted). */
  bootId: z.string(),
});
export type ReviewRecord = z.infer<typeof reviewRecordSchema>;

const fileSchema = z.object({ version: z.literal(1), reviews: z.array(reviewRecordSchema) });

export class ReviewStore {
  constructor(private readonly root: string) {}

  private fileFor(taskId: string): string {
    return join(this.root, `${createHash('sha256').update(taskId).digest('hex').slice(0, 32)}.json`);
  }

  list(taskId: string): ReviewRecord[] {
    const file = this.fileFor(taskId);
    if (!existsSync(file)) return [];
    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
      return parsed.success ? parsed.data.reviews.filter((review) => review.taskId === taskId) : [];
    } catch {
      return [];
    }
  }

  get(taskId: string, reviewId: string): ReviewRecord | null {
    return this.list(taskId).find((review) => review.id === reviewId) ?? null;
  }

  /** Insert or replace by id; newest first; bounded. */
  save(review: ReviewRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const others = this.list(review.taskId).filter((existing) => existing.id !== review.id);
    const reviews = [review, ...others]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, MAX_REVIEWS_PER_TASK);
    const file = this.fileFor(review.taskId);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, reviews }), { mode: 0o600 });
    renameSync(temp, file);
  }
}
