import type { ExecutionTaskAccess } from '@openlinear/api-client';
import { createPrincipalClient, toSidecarError } from '../config/cloud-api';
import { HttpError } from '../lib/errors';
import type { PrincipalCredential } from './principal';

/**
 * Resource authorization for sidecar routes, decided by the control plane
 * (`GET /api/executions/tasks/:taskId/access`) under the caller's own
 * credential, so project deny, membership, PAT scopes and PAT workspace
 * binding (W02a) all apply. Never cached: each decision reflects current
 * policy. API unreachable -> 503 (fail closed).
 *
 * Levels:
 * - `view`  : any read access to the task.
 * - `full`  : full task permission (the legacy sidecar `assertTaskOwned`
 *             level used for status and logs).
 * - `write` : full permission and a credential allowed to mutate execution
 *             state (sessions, or PATs with tasks:write).
 */
export type TaskAccessLevel = 'view' | 'full' | 'write';

export interface TaskAuthority {
  id: string;
  projectId: string | null;
  teamId: string | null;
  creatorId: string | null;
  archived: boolean;
  status: string;
}

export async function describeTaskAccess(credential: PrincipalCredential | null | undefined, taskId: string): Promise<ExecutionTaskAccess> {
  if (!credential) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
  try {
    return await createPrincipalClient(credential.token).getExecutionTaskAccess(taskId);
  } catch (error) {
    throw toSidecarError(error, 'task authorization');
  }
}

export async function authorizeTaskAccess(
  credential: PrincipalCredential | null | undefined,
  taskId: string,
  level: TaskAccessLevel,
): Promise<TaskAuthority> {
  const access = await describeTaskAccess(credential, taskId);
  const allowed = level === 'view'
    || (level === 'full' && access.permission === 'full')
    || (level === 'write' && access.canWrite);
  if (!allowed) {
    throw new HttpError(403, 'OWNERSHIP_REQUIRED', 'Required role is missing', { resourceType: 'task', resourceId: taskId });
  }
  return access.authority;
}
