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
}

/**
 * Per-request tenancy snapshot. Explicit project grants are stored so callers
 * can reason about deny/view/full without a second query; list filters still
 * use correlated EXISTS (see scoped where-builders) so we do not materialise
 * every accessible project id.
 */
export interface TenancyContext {
  userId: string;
  authSource: AuthSource;
  scopes: readonly string[];
  workspaces: ReadonlyMap<string, WorkspaceRole>;
  teams: ReadonlySet<string>;
  projectGrants: ReadonlyMap<string, ProjectGrant>;
  resolvedAt: number;
}
