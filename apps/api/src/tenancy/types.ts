import type { WorkspaceRole } from '@openlinear/db';

export type AuthSource = 'jwt' | 'pat';

export type ProjectGrant = 'full' | 'view' | 'deny';

export type Action = 'read' | 'create' | 'update' | 'delete' | 'manage' | 'execute' | 'view';

export type Resource =
  | { type: 'task'; id: string }
  | { type: 'project'; id: string }
  | { type: 'team'; id: string }
  | { type: 'workspace'; id: string };

export interface AuthContext {
  userId: string;
  authSource: AuthSource;
  /** PAT scopes. Empty for JWT (unrestricted by PAT). */
  scopes: readonly string[];
  /** PersonalAccessToken.id for PAT principals. */
  credentialId?: string | null;
  /**
   * Workspace a PAT is bound to (`PersonalAccessToken.workspaceId`). `null`
   * means account-wide. Always `null` for interactive sessions.
   */
  workspaceRestriction?: string | null;
}

/**
 * Per-request principal snapshot (W02a PrincipalContext).
 *
 * Built once by the auth middleware and bound to the request's async context,
 * so every policy check downstream (single-resource assertions, scoped list
 * builders, chat tools, sidecar ownership checks) sees the same principal.
 *
 * Explicit project grants are stored so callers can reason about
 * deny/view/full without a second query; list filters still use correlated
 * EXISTS (see scoped where-builders) so we do not materialise every
 * accessible project id. Single-resource assertions re-read memberships from
 * the database, so a revoked membership takes effect on the next request even
 * when this snapshot is cached.
 *
 * For a workspace-bound PAT the membership maps are already narrowed to that
 * workspace, and `workspaceRestriction` is enforced by every policy helper.
 */
export interface TenancyContext {
  userId: string;
  authSource: AuthSource;
  scopes: readonly string[];
  credentialId: string | null;
  workspaceRestriction: string | null;
  workspaces: ReadonlyMap<string, WorkspaceRole>;
  teams: ReadonlySet<string>;
  projectGrants: ReadonlyMap<string, ProjectGrant>;
  resolvedAt: number;
}

/** The central principal type consumed by policy checks. */
export type PrincipalContext = TenancyContext;
