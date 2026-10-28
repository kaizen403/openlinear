import { prisma } from '@openlinear/db';
import { logAccountAudit } from './account-audit';

/**
 * One-off remediation of personal access tokens that are broader than their
 * owner intended (W02b). Idempotent: every write is conditional on the row
 * still matching, nothing is ever widened or extended, and re-running finds
 * nothing left to do. Dry run unless `apply` is set. Run it with
 * `src/scripts/remediate-pats.ts`; never against a database you have not
 * been asked to change.
 *
 * Classes:
 *  1. Widened by losing their workspace binding. Before W02a, deleting a
 *     workspace set `personal_access_tokens.workspaceId` to NULL (the FK is
 *     ON DELETE SET NULL) without revoking, and NULL means account-wide. The
 *     only surviving evidence that a NULL-workspace token was created bound
 *     is a `pat.created` audit row carrying the workspace (`audit_logs`, or
 *     `account_audit_logs.metadata.workspaceId`). Matching live tokens are
 *     revoked. Caveat: `audit_logs` rows cascade with their workspace, so for
 *     tokens whose workspace was deleted the evidence is usually gone too;
 *     those tokens are indistinguishable from intentionally account-wide
 *     ones and are only counted (class 3). New widenings cannot happen: the
 *     route revokes first and the `personal_access_tokens_revoke_on_unbind`
 *     trigger revokes on any path.
 *  2. Legacy wildcard tokens (`scopes` contains `*`): created by the old
 *     dashboard, full access including admin, usually non-expiring. They get
 *     a sunset expiry (`now + wildcardSunsetDays`, never later than an
 *     existing expiry), or are revoked with `revokeWildcard`.
 *  3. Report only: live account-wide tokens created before `createdBefore`
 *     (the W02a deploy) that classes 1–2 did not cover.
 *
 * Every change writes a `pat.remediated` row to `account_audit_logs` in the
 * same transaction.
 */

export interface PatRemediationOptions {
  /** Write changes. Without it the report lists what would change. */
  apply: boolean;
  now?: Date;
  /** Days until legacy wildcard tokens expire (default 30). */
  wildcardSunsetDays?: number;
  /** Revoke legacy wildcard tokens instead of setting a sunset expiry. */
  revokeWildcard?: boolean;
  /** Cut-off for the class 3 count (default: `now`). */
  createdBefore?: Date;
  /** Limit the run to these token owners (targeted remediation, tests). */
  userIds?: string[];
}

export interface RemediatedToken {
  id: string;
  userId: string;
}

export interface PatRemediationReport {
  dryRun: boolean;
  /** Class 1: tokens revoked (or to revoke) because they lost their workspace binding. */
  unboundRevoked: Array<RemediatedToken & { originalWorkspaceId: string }>;
  /** Class 2: wildcard tokens given a sunset expiry. */
  wildcardExpiring: Array<RemediatedToken & { previousExpiresAt: string | null; expiresAt: string }>;
  /** Class 2 with `revokeWildcard`: wildcard tokens revoked. */
  wildcardRevoked: RemediatedToken[];
  /** Class 3: live account-wide tokens created before the cut-off, not covered above. */
  unclassifiedAccountWide: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SUNSET_DAYS = 30;

interface UnboundCandidate {
  id: string;
  userId: string;
  originalWorkspaceId: string;
}

async function findUnboundCandidates(userIds: string[] | undefined): Promise<UnboundCandidate[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string; userId: string; originalWorkspaceId: string }>>`
    SELECT DISTINCT ON (p."id") p."id" AS "id", p."userId" AS "userId", evidence."workspaceId" AS "originalWorkspaceId"
    FROM "personal_access_tokens" p
    JOIN (
      SELECT a."resourceId", a."workspaceId", a."createdAt"
      FROM "audit_logs" a
      WHERE a."action" = 'pat.created' AND a."resourceType" = 'personal_access_token'
      UNION ALL
      SELECT l."resourceId", l."metadata"->>'workspaceId', l."createdAt"
      FROM "account_audit_logs" l
      WHERE l."action" = 'pat.created'
        AND l."resourceType" = 'personal_access_token'
        AND l."metadata"->>'workspaceId' IS NOT NULL
    ) evidence ON evidence."resourceId" = p."id"
    WHERE p."workspaceId" IS NULL AND p."revokedAt" IS NULL
    ORDER BY p."id", evidence."createdAt" ASC
  `;
  return userIds ? rows.filter((row) => userIds.includes(row.userId)) : rows;
}

export async function remediatePersonalAccessTokens(
  options: PatRemediationOptions,
): Promise<PatRemediationReport> {
  const now = options.now ?? new Date();
  const sunsetDays = options.wildcardSunsetDays ?? DEFAULT_SUNSET_DAYS;
  if (!Number.isFinite(sunsetDays) || sunsetDays < 0) {
    throw new Error('wildcardSunsetDays must be a non-negative number');
  }
  const sunset = new Date(now.getTime() + sunsetDays * DAY_MS);
  const report: PatRemediationReport = {
    dryRun: !options.apply,
    unboundRevoked: [],
    wildcardExpiring: [],
    wildcardRevoked: [],
    unclassifiedAccountWide: 0,
  };
  const covered = new Set<string>();

  // Class 1: lost workspace binding.
  const owners = options.userIds ? { userId: { in: options.userIds } } : {};

  for (const candidate of await findUnboundCandidates(options.userIds)) {
    covered.add(candidate.id);
    if (!options.apply) {
      report.unboundRevoked.push(candidate);
      continue;
    }
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.personalAccessToken.updateMany({
        where: { id: candidate.id, workspaceId: null, revokedAt: null },
        data: { revokedAt: now },
      });
      if (result.count !== 1) return false;
      await logAccountAudit({
        userId: candidate.userId,
        actorId: null,
        action: 'pat.remediated',
        resourceType: 'personal_access_token',
        resourceId: candidate.id,
        metadata: { reason: 'workspace-binding-lost', originalWorkspaceId: candidate.originalWorkspaceId, change: 'revoked' },
      }, tx);
      return true;
    });
    if (changed) report.unboundRevoked.push(candidate);
  }

  // Class 2: legacy wildcard scope.
  const wildcard = await prisma.personalAccessToken.findMany({
    where: {
      ...owners,
      scopes: { has: '*' },
      revokedAt: null,
      ...(options.revokeWildcard ? {} : { OR: [{ expiresAt: null }, { expiresAt: { gt: sunset } }] }),
    },
    select: { id: true, userId: true, expiresAt: true },
    orderBy: { createdAt: 'asc' },
  });
  for (const token of wildcard) {
    covered.add(token.id);
    if (options.revokeWildcard) {
      if (!options.apply) {
        report.wildcardRevoked.push({ id: token.id, userId: token.userId });
        continue;
      }
      const changed = await prisma.$transaction(async (tx) => {
        const result = await tx.personalAccessToken.updateMany({
          where: { id: token.id, revokedAt: null, scopes: { has: '*' } },
          data: { revokedAt: now },
        });
        if (result.count !== 1) return false;
        await logAccountAudit({
          userId: token.userId,
          actorId: null,
          action: 'pat.remediated',
          resourceType: 'personal_access_token',
          resourceId: token.id,
          metadata: { reason: 'legacy-wildcard-scope', change: 'revoked' },
        }, tx);
        return true;
      });
      if (changed) report.wildcardRevoked.push({ id: token.id, userId: token.userId });
      continue;
    }

    const entry = {
      id: token.id,
      userId: token.userId,
      previousExpiresAt: token.expiresAt?.toISOString() ?? null,
      expiresAt: sunset.toISOString(),
    };
    if (!options.apply) {
      report.wildcardExpiring.push(entry);
      continue;
    }
    const changed = await prisma.$transaction(async (tx) => {
      const result = await tx.personalAccessToken.updateMany({
        where: {
          id: token.id,
          revokedAt: null,
          scopes: { has: '*' },
          OR: [{ expiresAt: null }, { expiresAt: { gt: sunset } }],
        },
        data: { expiresAt: sunset },
      });
      if (result.count !== 1) return false;
      await logAccountAudit({
        userId: token.userId,
        actorId: null,
        action: 'pat.remediated',
        resourceType: 'personal_access_token',
        resourceId: token.id,
        metadata: {
          reason: 'legacy-wildcard-scope',
          change: 'expiry-set',
          previousExpiresAt: entry.previousExpiresAt,
          expiresAt: entry.expiresAt,
        },
      }, tx);
      return true;
    });
    if (changed) report.wildcardExpiring.push(entry);
  }

  // Class 3: report only.
  const createdBefore = options.createdBefore ?? now;
  const unclassified = await prisma.personalAccessToken.findMany({
    where: {
      ...owners,
      workspaceId: null,
      revokedAt: null,
      createdAt: { lt: createdBefore },
      NOT: { scopes: { has: '*' } },
    },
    select: { id: true },
  });
  report.unclassifiedAccountWide = unclassified.filter((row) => !covered.has(row.id)).length;

  return report;
}
