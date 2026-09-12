export type AuthMode = 'session' | 'session_or_pat' | 'public' | 'optional';

export interface RouteDeclaration {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  auth: AuthMode;
  /** Tenancy / resource check. `none` is only valid for public health/auth start. */
  scope: string;
  patScopes: string[];
}

export const ROUTE_REGISTRY: RouteDeclaration[] = [
  { method: 'GET', path: '/livez', auth: 'public', scope: 'none', patScopes: [] },
  { method: 'GET', path: '/readyz', auth: 'public', scope: 'none', patScopes: [] },
  { method: 'GET', path: '/health', auth: 'public', scope: 'none', patScopes: [] },

  { method: 'GET', path: '/api/auth/github', auth: 'public', scope: 'none', patScopes: [] },
  { method: 'GET', path: '/api/auth/github/callback', auth: 'public', scope: 'none', patScopes: [] },
  { method: 'POST', path: '/api/auth/refresh', auth: 'public', scope: 'none', patScopes: [] },
  { method: 'GET', path: '/api/auth/me', auth: 'session_or_pat', scope: 'self', patScopes: ['read'] },
  { method: 'PATCH', path: '/api/auth/me', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/auth/logout', auth: 'session_or_pat', scope: 'self', patScopes: ['write'] },

  { method: 'POST', path: '/api/auth/2fa/setup', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/auth/2fa/verify', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/auth/2fa/disable', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/auth/2fa/validate', auth: 'public', scope: 'none', patScopes: [] },

  { method: 'GET', path: '/api/users/me', auth: 'session_or_pat', scope: 'self', patScopes: ['read'] },
  { method: 'PATCH', path: '/api/users/me', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/users/me/email-change', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/users/me/email-change/confirm', auth: 'session', scope: 'self', patScopes: [] },

  { method: 'GET', path: '/api/pats', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/pats', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'DELETE', path: '/api/pats/:id', auth: 'session', scope: 'self', patScopes: [] },

  { method: 'GET', path: '/api/sessions', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'DELETE', path: '/api/sessions/:id', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'POST', path: '/api/sessions/revoke-others', auth: 'session', scope: 'self', patScopes: [] },

  { method: 'POST', path: '/api/events/ticket', auth: 'session', scope: 'self', patScopes: [] },
  { method: 'GET', path: '/api/events', auth: 'public', scope: 'sse', patScopes: [] },

  { method: 'GET', path: '/api/workspaces', auth: 'session_or_pat', scope: 'workspace:list', patScopes: ['workspaces:read'] },
  { method: 'POST', path: '/api/workspaces', auth: 'session_or_pat', scope: 'workspace:create', patScopes: ['write'] },
  { method: 'GET', path: '/api/workspaces/:id', auth: 'session_or_pat', scope: 'workspace:read', patScopes: ['workspaces:read'] },
  { method: 'PATCH', path: '/api/workspaces/:id', auth: 'session_or_pat', scope: 'workspace:write', patScopes: ['write'] },
  { method: 'DELETE', path: '/api/workspaces/:id', auth: 'session_or_pat', scope: 'workspace:delete', patScopes: ['admin'] },
  { method: 'GET', path: '/api/workspaces/:id/members', auth: 'session_or_pat', scope: 'workspace:read', patScopes: ['workspaces:read'] },
  { method: 'POST', path: '/api/workspaces/:id/members', auth: 'session_or_pat', scope: 'workspace:members', patScopes: ['write'] },
  { method: 'POST', path: '/api/workspaces/:id/members/bulk', auth: 'session_or_pat', scope: 'workspace:members', patScopes: ['write'] },
  { method: 'PATCH', path: '/api/workspaces/:id/members/:userId', auth: 'session_or_pat', scope: 'workspace:members', patScopes: ['write'] },
  { method: 'DELETE', path: '/api/workspaces/:id/members/:userId', auth: 'session_or_pat', scope: 'workspace:members', patScopes: ['write'] },
  { method: 'GET', path: '/api/workspaces/:id/structure', auth: 'session_or_pat', scope: 'workspace:read', patScopes: ['workspaces:read'] },
  { method: 'GET', path: '/api/workspaces/:workspaceId/audit-log', auth: 'session_or_pat', scope: 'workspace:audit', patScopes: ['admin'] },

  { method: 'GET', path: '/api/projects', auth: 'optional', scope: 'project:list', patScopes: ['projects:read'] },
  { method: 'POST', path: '/api/projects', auth: 'session_or_pat', scope: 'project:create', patScopes: ['projects:write'] },
  { method: 'GET', path: '/api/projects/:id', auth: 'optional', scope: 'project:read', patScopes: ['projects:read'] },
  { method: 'PATCH', path: '/api/projects/:id', auth: 'session_or_pat', scope: 'project:write', patScopes: ['projects:write'] },
  { method: 'DELETE', path: '/api/projects/:id', auth: 'session_or_pat', scope: 'project:delete', patScopes: ['projects:write'] },
  { method: 'GET', path: '/api/projects/:id/access', auth: 'session_or_pat', scope: 'project:access', patScopes: ['projects:read'] },
  { method: 'POST', path: '/api/projects/:id/access', auth: 'session_or_pat', scope: 'project:access', patScopes: ['projects:write'] },
  { method: 'POST', path: '/api/projects/:id/access/bulk', auth: 'session_or_pat', scope: 'project:access', patScopes: ['projects:write'] },
  { method: 'DELETE', path: '/api/projects/:id/access/:userId', auth: 'session_or_pat', scope: 'project:access', patScopes: ['projects:write'] },

  { method: 'GET', path: '/api/teams', auth: 'optional', scope: 'team:list', patScopes: ['read'] },
  { method: 'POST', path: '/api/teams', auth: 'session_or_pat', scope: 'team:create', patScopes: ['write'] },
  { method: 'POST', path: '/api/teams/join', auth: 'session_or_pat', scope: 'team:join', patScopes: ['write'] },
  { method: 'GET', path: '/api/teams/:id', auth: 'session_or_pat', scope: 'team:read', patScopes: ['read'] },
  { method: 'PATCH', path: '/api/teams/:id', auth: 'session_or_pat', scope: 'team:write', patScopes: ['write'] },
  { method: 'DELETE', path: '/api/teams/:id', auth: 'session_or_pat', scope: 'team:delete', patScopes: ['write'] },
  { method: 'GET', path: '/api/teams/:id/members', auth: 'session_or_pat', scope: 'team:read', patScopes: ['read'] },
  { method: 'POST', path: '/api/teams/:id/members', auth: 'session_or_pat', scope: 'team:members', patScopes: ['write'] },
  { method: 'PATCH', path: '/api/teams/:id/members/:userId', auth: 'session_or_pat', scope: 'team:members', patScopes: ['write'] },
  { method: 'DELETE', path: '/api/teams/:id/members/:userId', auth: 'session_or_pat', scope: 'team:members', patScopes: ['write'] },

  { method: 'GET', path: '/api/tasks', auth: 'session_or_pat', scope: 'task:list', patScopes: ['tasks:read'] },
  { method: 'POST', path: '/api/tasks', auth: 'session_or_pat', scope: 'task:create', patScopes: ['tasks:write'] },
  { method: 'GET', path: '/api/tasks/archived', auth: 'session_or_pat', scope: 'task:list', patScopes: ['tasks:read'] },
  { method: 'DELETE', path: '/api/tasks/archived', auth: 'session_or_pat', scope: 'task:delete', patScopes: ['tasks:write'] },
  { method: 'DELETE', path: '/api/tasks/archived/:id', auth: 'session_or_pat', scope: 'task:delete', patScopes: ['tasks:write'] },
  { method: 'POST', path: '/api/tasks/bulk', auth: 'session_or_pat', scope: 'task:create', patScopes: ['tasks:write'] },
  { method: 'PATCH', path: '/api/tasks/bulk-status', auth: 'session_or_pat', scope: 'task:write', patScopes: ['tasks:write'] },
  { method: 'POST', path: '/api/tasks/bulk-archive', auth: 'session_or_pat', scope: 'task:write', patScopes: ['tasks:write'] },
  { method: 'POST', path: '/api/tasks/bulk-delete', auth: 'session_or_pat', scope: 'task:delete', patScopes: ['tasks:write'] },
  { method: 'GET', path: '/api/tasks/:id', auth: 'session_or_pat', scope: 'task:read', patScopes: ['tasks:read'] },
  { method: 'PATCH', path: '/api/tasks/:id', auth: 'session_or_pat', scope: 'task:write', patScopes: ['tasks:write'] },
  { method: 'DELETE', path: '/api/tasks/:id', auth: 'session_or_pat', scope: 'task:delete', patScopes: ['tasks:write'] },

  { method: 'GET', path: '/api/labels', auth: 'session_or_pat', scope: 'label:list', patScopes: ['read'] },
  { method: 'POST', path: '/api/labels', auth: 'session_or_pat', scope: 'label:write', patScopes: ['labels:write'] },
  { method: 'PATCH', path: '/api/labels/:id', auth: 'session_or_pat', scope: 'label:write', patScopes: ['labels:write'] },
  { method: 'DELETE', path: '/api/labels/:id', auth: 'session_or_pat', scope: 'label:write', patScopes: ['labels:write'] },
  { method: 'POST', path: '/api/labels/tasks/:id/labels', auth: 'session_or_pat', scope: 'task:write', patScopes: ['tasks:write'] },
  { method: 'DELETE', path: '/api/labels/tasks/:id/labels/:labelId', auth: 'session_or_pat', scope: 'task:write', patScopes: ['tasks:write'] },

  { method: 'GET', path: '/api/repos', auth: 'session_or_pat', scope: 'repo:list', patScopes: ['read'] },
  { method: 'GET', path: '/api/repos/public', auth: 'session_or_pat', scope: 'repo:list', patScopes: ['read'] },
  { method: 'GET', path: '/api/repos/active', auth: 'session_or_pat', scope: 'repo:read', patScopes: ['read'] },
  { method: 'GET', path: '/api/repos/active/public', auth: 'session_or_pat', scope: 'repo:read', patScopes: ['read'] },
  { method: 'POST', path: '/api/repos/url', auth: 'session_or_pat', scope: 'repo:write', patScopes: ['write'] },
  { method: 'POST', path: '/api/repos/import', auth: 'session_or_pat', scope: 'repo:write', patScopes: ['write'] },
  { method: 'POST', path: '/api/repos/:id/activate', auth: 'session_or_pat', scope: 'repo:write', patScopes: ['write'] },
  { method: 'POST', path: '/api/repos/:id/activate/public', auth: 'session_or_pat', scope: 'repo:write', patScopes: ['write'] },
  { method: 'GET', path: '/api/repos/github', auth: 'session_or_pat', scope: 'repo:github', patScopes: ['read'] },
  { method: 'GET', path: '/api/repos/github/:owner/:repo/branches', auth: 'session_or_pat', scope: 'repo:github', patScopes: ['read'] },
  { method: 'PATCH', path: '/api/repos/active/base-branch', auth: 'session_or_pat', scope: 'repo:write', patScopes: ['write'] },

  { method: 'GET', path: '/api/search', auth: 'session_or_pat', scope: 'search', patScopes: ['read'] },
  { method: 'GET', path: '/api/inbox', auth: 'session_or_pat', scope: 'inbox', patScopes: ['read'] },
  { method: 'GET', path: '/api/inbox/count', auth: 'optional', scope: 'inbox', patScopes: ['read'] },
  { method: 'PATCH', path: '/api/inbox/read/:id', auth: 'session_or_pat', scope: 'inbox', patScopes: ['write'] },
  { method: 'PATCH', path: '/api/inbox/read-all', auth: 'optional', scope: 'inbox', patScopes: ['write'] },
  { method: 'GET', path: '/api/dashboard', auth: 'session_or_pat', scope: 'dashboard', patScopes: ['read'] },
  { method: 'GET', path: '/api/activity', auth: 'session_or_pat', scope: 'activity', patScopes: ['read'] },
  { method: 'GET', path: '/api/notifications', auth: 'session_or_pat', scope: 'notifications', patScopes: ['read'] },
  { method: 'GET', path: '/api/settings', auth: 'session_or_pat', scope: 'settings', patScopes: ['read'] },
  { method: 'PATCH', path: '/api/settings', auth: 'session_or_pat', scope: 'settings', patScopes: ['write'] },

  { method: 'GET', path: '/api/agent-runs', auth: 'session_or_pat', scope: 'agent-run:list', patScopes: ['tasks:read'] },
  { method: 'POST', path: '/api/agent-runs', auth: 'session_or_pat', scope: 'agent-run:write', patScopes: ['tasks:write'] },
  { method: 'PATCH', path: '/api/agent-runs/:id', auth: 'session_or_pat', scope: 'agent-run:write', patScopes: ['tasks:write'] },
  { method: 'POST', path: '/api/agent-runs/progress', auth: 'session_or_pat', scope: 'agent-run:write', patScopes: ['tasks:write'] },
  { method: 'GET', path: '/api/usage/summary', auth: 'session_or_pat', scope: 'usage', patScopes: ['read'] },
  { method: 'GET', path: '/api/usage/by-task', auth: 'session_or_pat', scope: 'usage', patScopes: ['read'] },
  { method: 'GET', path: '/api/models', auth: 'session_or_pat', scope: 'models', patScopes: ['read'] },
  { method: 'PATCH', path: '/api/tasks/:id/execution', auth: 'session_or_pat', scope: 'task:write', patScopes: ['tasks:write'] },
  { method: 'GET', path: '/api/users/me/scm-token', auth: 'session_or_pat', scope: 'self', patScopes: ['write'] },
  { method: 'GET', path: '/api/repos/:id', auth: 'session_or_pat', scope: 'repo:read', patScopes: ['read'] },

  { method: 'POST', path: '/api/workspaces/:workspaceId/sso', auth: 'session', scope: 'sso:write', patScopes: [] },
  { method: 'GET', path: '/api/workspaces/:workspaceId/sso', auth: 'session', scope: 'sso:read', patScopes: [] },
  { method: 'DELETE', path: '/api/workspaces/:workspaceId/sso', auth: 'session', scope: 'sso:write', patScopes: [] },
  { method: 'POST', path: '/api/workspaces/:workspaceId/sso/verify-domain', auth: 'session', scope: 'sso:write', patScopes: [] },
  { method: 'GET', path: '/api/auth/sso/check', auth: 'public', scope: 'none', patScopes: [] },
  { method: 'GET', path: '/api/auth/sso/callback', auth: 'public', scope: 'none', patScopes: [] },
];

export function routeKey(route: Pick<RouteDeclaration, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

export function assertRegistryComplete(routes: RouteDeclaration[]): void {
  const seen = new Set<string>();
  for (const route of routes) {
    if (!route.scope) {
      throw new Error(`${routeKey(route)} is missing scope`);
    }
    if (route.auth === 'session_or_pat' && route.patScopes.length === 0) {
      throw new Error(`${routeKey(route)} allows PATs but declares no patScopes`);
    }
    const key = routeKey(route);
    if (seen.has(key)) {
      throw new Error(`Duplicate registry entry ${key}`);
    }
    seen.add(key);
  }
}
