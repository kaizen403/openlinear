import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';
import {
  Permission,
  WorkspaceRole,
  TeamRole,
  type Role,
} from '@openlinear/db';

export type AppAction =
  | 'create'
  | 'read'
  | 'update'
  | 'delete'
  | 'manage'
  | 'execute'
  | 'invite'
  | 'view';

export type AppSubject =
  | 'Task'
  | 'Project'
  | 'Team'
  | 'Workspace'
  | 'Member'
  | 'Role'
  | 'all';

export type AppAbility = MongoAbility<[AppAction, AppSubject]>;

/**
 * Maps a Prisma Permission enum value to a CASL action/subject pair.
 *
 *   create_task    → can('create',  'Task')
 *   read_task      → can('read',    'Task')
 *   update_task    → can('update',  'Task')
 *   delete_task    → can('delete',  'Task')
 *   manage_members → can('manage',  'Member')
 *   manage_roles   → can('manage',  'Role')
 *   execute_agent  → can('execute', 'Task')
 *   manage_billing → can('manage',  'Workspace')
 *   manage_project → can('manage',  'Project')
 *   manage_team    → can('manage',  'Team')
 *   manage_workspace → can('manage','Workspace')
 *   invite_members → can('invite',  'Member')
 *   view_analytics → can('view',    'Workspace')
 */
const PERMISSION_RULE_MAP: Record<
  Permission,
  { action: AppAction; subject: AppSubject }
> = {
  create_task: { action: 'create', subject: 'Task' },
  read_task: { action: 'read', subject: 'Task' },
  update_task: { action: 'update', subject: 'Task' },
  delete_task: { action: 'delete', subject: 'Task' },
  manage_members: { action: 'manage', subject: 'Member' },
  manage_roles: { action: 'manage', subject: 'Role' },
  execute_agent: { action: 'execute', subject: 'Task' },
  manage_billing: { action: 'manage', subject: 'Workspace' },
  manage_project: { action: 'manage', subject: 'Project' },
  manage_team: { action: 'manage', subject: 'Team' },
  manage_workspace: { action: 'manage', subject: 'Workspace' },
  invite_members: { action: 'invite', subject: 'Member' },
  view_analytics: { action: 'view', subject: 'Workspace' },
};

const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, Permission[]> = {
  owner: Object.values(Permission),
  admin: Object.values(Permission).filter((p) => p !== 'manage_billing'),
  member: [
    'create_task',
    'read_task',
    'update_task',
    'execute_agent',
    'invite_members',
    'view_analytics',
  ],
  viewer: ['read_task', 'view_analytics'],
};

const TEAM_ROLE_PERMISSIONS: Record<TeamRole, Permission[]> = {
  owner: [
    'create_task',
    'read_task',
    'update_task',
    'delete_task',
    'manage_members',
    'manage_roles',
    'execute_agent',
    'manage_project',
    'manage_team',
    'invite_members',
    'view_analytics',
  ],
  admin: [
    'create_task',
    'read_task',
    'update_task',
    'delete_task',
    'manage_members',
    'execute_agent',
    'manage_project',
    'manage_team',
    'invite_members',
    'view_analytics',
  ],
  member: [
    'create_task',
    'read_task',
    'update_task',
    'execute_agent',
    'invite_members',
  ],
};

/**
 * Build a CASL Ability from an array of Permission values.
 *
 * Duplicate rules are harmless — CASL deduplicates internally.
 */
export function buildAbilityFromPermissions(
  permissions: Permission[],
): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  for (const permission of permissions) {
    const rule = PERMISSION_RULE_MAP[permission];
    if (rule) {
      can(rule.action, rule.subject);
    }
  }

  return build();
}

/**
 * Collect all effective permissions for a user from their memberships.
 *
 * - If a membership has a custom `roleRef`, use that role's `permissions`.
 * - If `roleId` is null, fall back to the base enum role
 *   (`WorkspaceRole` for workspace members, `TeamRole` for team members).
 *
 * Returns a deduplicated array of Permission values.
 */
export function collectEffectivePermissions(
  workspaceMembers: Array<{
    role: WorkspaceRole;
    roleRef: Pick<Role, 'permissions'> | null;
  }>,
  teamMembers: Array<{
    role: TeamRole;
    roleRef: Pick<Role, 'permissions'> | null;
  }>,
  projectAccess: Array<{
    roleRef: Pick<Role, 'permissions'> | null;
  }>,
): Permission[] {
  const set = new Set<Permission>();

  for (const wm of workspaceMembers) {
    if (wm.roleRef) {
      for (const p of wm.roleRef.permissions) {
        set.add(p);
      }
    } else {
      for (const p of WORKSPACE_ROLE_PERMISSIONS[wm.role]) {
        set.add(p);
      }
    }
  }

  for (const tm of teamMembers) {
    if (tm.roleRef) {
      for (const p of tm.roleRef.permissions) {
        set.add(p);
      }
    } else {
      for (const p of TEAM_ROLE_PERMISSIONS[tm.role]) {
        set.add(p);
      }
    }
  }

  for (const pa of projectAccess) {
    if (pa.roleRef) {
      for (const p of pa.roleRef.permissions) {
        set.add(p);
      }
    }
    // ProjectAccess has no base enum fallback — if roleId is null,
    // the ProjectPermission enum (full/view/deny) is used elsewhere.
    // We intentionally skip it here because it is not a Permission[] value.
  }

  return Array.from(set);
}
