import { prisma, type KnowledgeEntry, type Prisma } from '@openlinear/db';
import { HttpError } from '../errors';
import { transactionWithEvents } from '../events/outbox';
import { appendToTarget, projectTarget } from '../events/targets';
import type {
  CreateKnowledgeBody,
  KnowledgeKind,
  KnowledgeSourceRef,
  KnowledgeStatus,
  UpdateKnowledgeBody,
} from '../schemas/knowledge';
import type { IdempotentCommand } from './idempotency';
import { assertProjectAccess } from './ownership';
import { resolveProjectWorkspaceId } from './tasks';

/**
 * W19b / FE-13: project knowledge. See docs/reports/revamp-2026-10-26/knowledge.md.
 *
 * What the team wants every agent run in a project to know. Trust rules:
 *
 * - **People write, agents propose.** A signed-in person's entry is active
 *   at once; a personal access token (the MCP worker, scripts) can only
 *   create `proposed` entries and edit its proposals. Approving, retracting,
 *   restoring and editing an active entry need a person.
 * - **Provenance.** Each entry keeps where it came from (`sourceRef`: task,
 *   run, review finding, commit, chat). The task is checked (same project,
 *   not sealed — evaluation tasks never enter memory); run, review and
 *   finding ids are device-local references recorded as given.
 * - **Agents can't crowd people out:** at most MAX_OPEN_PROPOSALS open
 *   proposals per project.
 * - **History.** Every change is a revision (`KnowledgeVersion`); edits are
 *   based on the latest revision (409 otherwise); retraction keeps it all.
 * - **Bounded use.** Active, unexpired entries are sealed into each run's
 *   execution snapshot (at most PROMPT_ENTRIES / PROMPT_CHARS), conventions
 *   and procedures first.
 */

export const MAX_KNOWLEDGE_PER_PROJECT = 200;
/** Open agent proposals per project (so agents cannot use up the people's quota). */
export const MAX_OPEN_PROPOSALS = 50;
export const PROMPT_ENTRIES = 20;
export const PROMPT_CHARS = 8_000;
const VERSIONS_SHOWN = 50;
const SEALED_LABELS = new Set(['sealed', 'eval:sealed']);

export interface KnowledgeActor {
  userId: string;
  /** `pat` = an agent or script (proposals only); `jwt` = a signed-in person. */
  authSource: 'jwt' | 'pat';
}

export interface KnowledgeView {
  id: string;
  projectId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  status: KnowledgeStatus;
  source: 'user' | 'agent' | 'review_finding';
  sourceRef: KnowledgeSourceRef | null;
  version: number;
  expiresAt: string | null;
  /** Past its expiry: kept, but no longer given to runs. */
  expired: boolean;
  createdById: string;
  updatedById: string;
  approvedById: string | null;
  approvedAt: string | null;
  retractedById: string | null;
  retractedAt: string | null;
  retractReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeVersionView {
  version: number;
  kind: string;
  title: string;
  body: string;
  status: string;
  change: string;
  note: string | null;
  editedById: string;
  createdAt: string;
}

/** What a run is given (sealed into its execution snapshot). */
export interface PromptKnowledge {
  id: string;
  version: number;
  kind: KnowledgeKind;
  title: string;
  body: string;
}

function isPerson(actor: KnowledgeActor): boolean {
  return actor.authSource === 'jwt';
}

function peopleOnly(action: string): HttpError {
  return new HttpError(403, 'KNOWLEDGE_PEOPLE_ONLY', `Only a signed-in person can ${action}; agents can propose knowledge for people to approve`);
}

function kindOf(value: string): KnowledgeKind {
  return value === 'convention' || value === 'procedure' ? value : 'note';
}

function statusOf(value: string): KnowledgeStatus {
  return value === 'proposed' || value === 'retracted' ? value : 'active';
}

function sourceOf(value: string): KnowledgeView['source'] {
  return value === 'agent' || value === 'review_finding' ? value : 'user';
}

function sourceRefOf(value: Prisma.JsonValue | null): KnowledgeSourceRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ref: KnowledgeSourceRef = {};
  for (const key of ['taskId', 'runId', 'reviewId', 'findingId', 'commit', 'chatSessionId'] as const) {
    const field = value[key];
    if (typeof field === 'string') ref[key] = field;
  }
  return ref;
}

export function isSealedTask(labels: ReadonlyArray<string>): boolean {
  return labels.some((label) => SEALED_LABELS.has(label.trim().toLowerCase()));
}

function toView(entry: KnowledgeEntry, now: Date = new Date()): KnowledgeView {
  return {
    id: entry.id,
    projectId: entry.projectId,
    kind: kindOf(entry.kind),
    title: entry.title,
    body: entry.body,
    status: statusOf(entry.status),
    source: sourceOf(entry.source),
    sourceRef: sourceRefOf(entry.sourceRef),
    version: entry.version,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    expired: entry.expiresAt !== null && entry.expiresAt <= now,
    createdById: entry.createdById,
    updatedById: entry.updatedById,
    approvedById: entry.approvedById,
    approvedAt: entry.approvedAt?.toISOString() ?? null,
    retractedById: entry.retractedById,
    retractedAt: entry.retractedAt?.toISOString() ?? null,
    retractReason: entry.retractReason,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

async function loadEntry(entryId: string): Promise<KnowledgeEntry> {
  const entry = await prisma.knowledgeEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new HttpError(404, 'KNOWLEDGE_NOT_FOUND', 'Knowledge entry not found');
  return entry;
}

/** The entry, row-locked for this transaction. */
async function lockEntry(tx: Prisma.TransactionClient, entryId: string): Promise<KnowledgeEntry> {
  await tx.$queryRaw`SELECT id FROM "knowledge_entries" WHERE id = ${entryId} FOR UPDATE`;
  const entry = await tx.knowledgeEntry.findUnique({ where: { id: entryId } });
  if (!entry) throw new HttpError(404, 'KNOWLEDGE_NOT_FOUND', 'Knowledge entry not found');
  return entry;
}

async function lockProjectKnowledge(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`openlinear-knowledge:${projectId}`}, 0))`;
}

async function assertQuota(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  const count = await tx.knowledgeEntry.count({ where: { projectId, status: { not: 'retracted' } } });
  if (count >= MAX_KNOWLEDGE_PER_PROJECT) {
    throw new HttpError(409, 'KNOWLEDGE_QUOTA_EXCEEDED', `A project keeps at most ${MAX_KNOWLEDGE_PER_PROJECT} knowledge entries; retract ones that no longer apply`, { limit: MAX_KNOWLEDGE_PER_PROJECT });
  }
}

function assertVersion(entry: KnowledgeEntry, version: number): void {
  if (entry.version !== version) {
    throw new HttpError(409, 'KNOWLEDGE_VERSION_CONFLICT', 'This entry changed since you opened it; review the latest revision', { latest: entry.version });
  }
}

async function recordRevision(
  tx: Prisma.TransactionClient,
  entry: KnowledgeEntry,
  change: 'created' | 'edited' | 'approved' | 'retracted' | 'restored',
  editedById: string,
  note: string | null = null,
): Promise<void> {
  await tx.knowledgeVersion.create({
    data: { entryId: entry.id, version: entry.version, kind: entry.kind, title: entry.title, body: entry.body, status: entry.status, change, note, editedById },
  });
  await appendToTarget(tx, await projectTarget(tx, entry.projectId), 'knowledge:changed', { projectId: entry.projectId, entryId: entry.id, status: entry.status, version: entry.version, change }, editedById);
}

/** A task named as the source must be in the project and must not be sealed. */
async function assertSource(projectId: string, sourceRef: KnowledgeSourceRef | undefined): Promise<void> {
  if (!sourceRef?.taskId) return;
  const task = await prisma.task.findUnique({
    where: { id: sourceRef.taskId },
    select: { projectId: true, labels: { select: { label: { select: { name: true } } } } },
  });
  if (!task || task.projectId !== projectId) {
    throw new HttpError(400, 'KNOWLEDGE_SOURCE_INVALID', 'The source task is not in this project', { field: 'sourceRef.taskId' });
  }
  if (isSealedTask(task.labels.map((relation) => relation.label.name))) {
    throw new HttpError(409, 'KNOWLEDGE_SEALED_SOURCE', 'Knowledge cannot come from a sealed (evaluation) task');
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listKnowledge(input: { projectId: string; userId: string; status: KnowledgeStatus | 'all' }): Promise<KnowledgeView[]> {
  await assertProjectAccess(input.projectId, input.userId, 'view');
  const entries = await prisma.knowledgeEntry.findMany({
    where: { projectId: input.projectId, ...(input.status === 'all' ? {} : { status: input.status }) },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: MAX_KNOWLEDGE_PER_PROJECT * 2,
  });
  const now = new Date();
  return entries.map((entry) => toView(entry, now));
}

export async function getKnowledge(input: { entryId: string; userId: string }): Promise<KnowledgeView & { versions: KnowledgeVersionView[] }> {
  const entry = await loadEntry(input.entryId);
  await assertProjectAccess(entry.projectId, input.userId, 'view');
  const versions = await prisma.knowledgeVersion.findMany({ where: { entryId: entry.id }, orderBy: { version: 'desc' }, take: VERSIONS_SHOWN });
  return {
    ...toView(entry),
    versions: versions.map((version) => ({
      version: version.version,
      kind: version.kind,
      title: version.title,
      body: version.body,
      status: version.status,
      change: version.change,
      note: version.note,
      editedById: version.editedById,
      createdAt: version.createdAt.toISOString(),
    })),
  };
}

/**
 * The knowledge a run of a task in `projectId` is given: active, unexpired
 * entries, conventions then procedures then notes, newest first, within the
 * entry and character budgets.
 */
export async function promptKnowledge(projectId: string | null, now: Date = new Date()): Promise<PromptKnowledge[]> {
  if (!projectId) return [];
  const entries = await prisma.knowledgeEntry.findMany({
    where: { projectId, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, version: true, kind: true, title: true, body: true, updatedAt: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: MAX_KNOWLEDGE_PER_PROJECT,
  });
  const rank: Record<KnowledgeKind, number> = { convention: 0, procedure: 1, note: 2 };
  const ordered = entries
    .map((entry) => ({ id: entry.id, version: entry.version, kind: kindOf(entry.kind), title: entry.title, body: entry.body, updatedAt: entry.updatedAt.getTime() }))
    .sort((a, b) => rank[a.kind] - rank[b.kind] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const chosen: PromptKnowledge[] = [];
  let chars = 0;
  for (const entry of ordered) {
    if (chosen.length >= PROMPT_ENTRIES) break;
    const size = entry.title.length + entry.body.length;
    if (chars + size > PROMPT_CHARS) continue;
    chars += size;
    chosen.push({ id: entry.id, version: entry.version, kind: entry.kind, title: entry.title, body: entry.body });
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function authorizeCreateKnowledge(input: { projectId: string; actor: KnowledgeActor; body: CreateKnowledgeBody }): Promise<IdempotentCommand<null, KnowledgeView>> {
  await assertProjectAccess(input.projectId, input.actor.userId, 'full');
  await assertSource(input.projectId, input.body.sourceRef);
  const person = isPerson(input.actor);
  return {
    resolveWorkspaceId: () => resolveProjectWorkspaceId(input.projectId),
    prepare: async () => null,
    mutate: async (tx) => {
      await lockProjectKnowledge(tx, input.projectId);
      await assertQuota(tx, input.projectId);
      if (!person && await tx.knowledgeEntry.count({ where: { projectId: input.projectId, status: 'proposed' } }) >= MAX_OPEN_PROPOSALS) {
        throw new HttpError(409, 'KNOWLEDGE_PROPOSALS_FULL', `${MAX_OPEN_PROPOSALS} proposals already wait for approval in this project; ask a person to review them first`, { limit: MAX_OPEN_PROPOSALS });
      }
      const now = new Date();
      const entry = await tx.knowledgeEntry.create({
        data: {
          projectId: input.projectId,
          kind: input.body.kind,
          title: input.body.title,
          body: input.body.body,
          status: person ? 'active' : 'proposed',
          source: !person ? 'agent' : input.body.sourceRef?.findingId ? 'review_finding' : 'user',
          ...(input.body.sourceRef ? { sourceRef: input.body.sourceRef } : {}),
          expiresAt: input.body.expiresAt ? new Date(input.body.expiresAt) : null,
          createdById: input.actor.userId,
          updatedById: input.actor.userId,
          ...(person ? { approvedById: input.actor.userId, approvedAt: now } : {}),
        },
      });
      await recordRevision(tx, entry, 'created', input.actor.userId);
      return { status: 201, body: toView(entry, now) };
    },
  };
}

export async function updateKnowledge(input: { entryId: string; actor: KnowledgeActor; body: UpdateKnowledgeBody }): Promise<KnowledgeView> {
  const current = await loadEntry(input.entryId);
  await assertProjectAccess(current.projectId, input.actor.userId, 'full');
  return transactionWithEvents(async (tx) => {
    const entry = await lockEntry(tx, input.entryId);
    assertVersion(entry, input.body.baseVersion);
    if (entry.status === 'retracted') throw new HttpError(409, 'KNOWLEDGE_RETRACTED', 'This entry was retracted; restore it before editing');
    // An agent may refine only an agent proposal of its own user, while it is still a proposal.
    if (!isPerson(input.actor) && (entry.status !== 'proposed' || entry.source !== 'agent' || entry.createdById !== input.actor.userId)) {
      throw peopleOnly(entry.status === 'proposed' ? "change someone else's proposal" : 'change knowledge that agents already read');
    }
    const updated = await tx.knowledgeEntry.update({
      where: { id: entry.id },
      data: {
        ...(input.body.kind !== undefined ? { kind: input.body.kind } : {}),
        ...(input.body.title !== undefined ? { title: input.body.title } : {}),
        ...(input.body.body !== undefined ? { body: input.body.body } : {}),
        ...(input.body.expiresAt !== undefined ? { expiresAt: input.body.expiresAt ? new Date(input.body.expiresAt) : null } : {}),
        version: entry.version + 1,
        updatedById: input.actor.userId,
        // A person editing an active entry vouches for the new text.
        ...(entry.status === 'active' ? { approvedById: input.actor.userId, approvedAt: new Date() } : {}),
      },
    });
    await recordRevision(tx, updated, 'edited', input.actor.userId);
    return toView(updated);
  });
}

export async function approveKnowledge(input: { entryId: string; actor: KnowledgeActor; version: number }): Promise<KnowledgeView> {
  if (!isPerson(input.actor)) throw peopleOnly('approve knowledge');
  const current = await loadEntry(input.entryId);
  await assertProjectAccess(current.projectId, input.actor.userId, 'full');
  return transactionWithEvents(async (tx) => {
    const entry = await lockEntry(tx, input.entryId);
    assertVersion(entry, input.version);
    if (entry.status !== 'proposed') throw new HttpError(409, 'KNOWLEDGE_NOT_PROPOSED', `This entry is ${entry.status}, not waiting for approval`);
    const updated = await tx.knowledgeEntry.update({
      where: { id: entry.id },
      data: { status: 'active', version: entry.version + 1, updatedById: input.actor.userId, approvedById: input.actor.userId, approvedAt: new Date() },
    });
    await recordRevision(tx, updated, 'approved', input.actor.userId);
    return toView(updated);
  });
}

export async function retractKnowledge(input: { entryId: string; actor: KnowledgeActor; reason: string }): Promise<KnowledgeView> {
  if (!isPerson(input.actor)) throw peopleOnly('retract knowledge');
  const current = await loadEntry(input.entryId);
  await assertProjectAccess(current.projectId, input.actor.userId, 'full');
  return transactionWithEvents(async (tx) => {
    const entry = await lockEntry(tx, input.entryId);
    if (entry.status === 'retracted') return toView(entry);
    const updated = await tx.knowledgeEntry.update({
      where: { id: entry.id },
      data: { status: 'retracted', version: entry.version + 1, updatedById: input.actor.userId, retractedById: input.actor.userId, retractedAt: new Date(), retractReason: input.reason },
    });
    await recordRevision(tx, updated, 'retracted', input.actor.userId, input.reason);
    return toView(updated);
  });
}

export async function restoreKnowledge(input: { entryId: string; actor: KnowledgeActor }): Promise<KnowledgeView> {
  if (!isPerson(input.actor)) throw peopleOnly('restore knowledge');
  const current = await loadEntry(input.entryId);
  await assertProjectAccess(current.projectId, input.actor.userId, 'full');
  return transactionWithEvents(async (tx) => {
    await lockProjectKnowledge(tx, current.projectId);
    const entry = await lockEntry(tx, input.entryId);
    if (entry.status !== 'retracted') throw new HttpError(409, 'KNOWLEDGE_NOT_RETRACTED', 'Only a retracted entry can be restored');
    await assertQuota(tx, entry.projectId);
    // A rejected proposal (never approved) comes back as a proposal: approving
    // it stays a separate, revision-bound step.
    const wasApproved = entry.approvedAt !== null;
    const updated = await tx.knowledgeEntry.update({
      where: { id: entry.id },
      data: {
        status: wasApproved ? 'active' : 'proposed',
        version: entry.version + 1,
        updatedById: input.actor.userId,
        ...(wasApproved ? { approvedById: input.actor.userId, approvedAt: new Date() } : {}),
        retractedById: null,
        retractedAt: null,
        retractReason: null,
      },
    });
    await recordRevision(tx, updated, 'restored', input.actor.userId);
    return toView(updated);
  });
}
