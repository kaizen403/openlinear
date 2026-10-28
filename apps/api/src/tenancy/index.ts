export type {
  Action,
  AuthContext,
  AuthSource,
  PrincipalContext,
  ProjectGrant,
  Resource,
  TenancyContext,
} from './types';
export {
  enterTenancy,
  getTenancyContext,
  invalidateTenancyCache,
  principalFor,
  requireTenancyContext,
  resolvePrincipalForUser,
  resolveTenancyContext,
  runWithPrincipal,
  workspaceRestrictionFor,
} from './context';
export type { ResolveTenancyOptions } from './context';
export {
  principalProjectScope,
  projectAccessWhere,
  scopedActivityWhere,
  scopedProjectWhere,
  scopedTaskWhere,
  scopedTeamWhere,
} from './scopes';
export type { ProjectAccessPermission } from './scopes';
export {
  canReceiveEvent,
  canViewProjectInSnapshot,
  deniedProjectIds,
  EVENT_RESOURCE_TYPES,
  isEventResourceType,
} from './visibility';
export type { EventAudienceRef, EventResourceType, ProjectSnapshotRef } from './visibility';
export { assertCan, can } from './policy';
