export type {
  Action,
  AuthContext,
  AuthSource,
  ProjectGrant,
  Resource,
  TenancyContext,
} from './types';
export {
  enterTenancy,
  getTenancyContext,
  invalidateTenancyCache,
  requireTenancyContext,
  resolveTenancyContext,
} from './context';
export {
  projectAccessWhere,
  scopedActivityWhere,
  scopedProjectWhere,
  scopedTaskWhere,
  scopedTeamWhere,
} from './scopes';
export type { ProjectAccessPermission } from './scopes';
export { assertCan, can } from './policy';
