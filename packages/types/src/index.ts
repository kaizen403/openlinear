export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

export type Priority = 'low' | 'medium' | 'high';

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'viewer';

export type ProjectPermission = 'full' | 'view' | 'deny';

export type TeamRole = 'owner' | 'admin' | 'member';

export type ProjectStatus =
  | 'planned'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'cancelled';

export type IssueLinkType =
  | 'blocks'
  | 'blocked_by'
  | 'relates_to'
  | 'duplicates'
  | 'duplicated_by';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role?: WorkspaceRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  invitedAt: Date;
  joinedAt?: Date | null;
}

export interface Project {
  id: string;
  workspaceId?: string | null;
  key?: string | null;
  name: string;
  description?: string | null;
  status: ProjectStatus;
  color?: string | null;
  icon?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectAccess {
  id: string;
  projectId: string;
  userId: string;
  permission: ProjectPermission;
  grantedAt: Date;
}

export interface Team {
  id: string;
  projectId?: string | null;
  name: string;
  key: string;
  color?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  role: TeamRole;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  labels: string[];
  workspaceId?: string | null;
  teamId?: string | null;
  assigneeId?: string;
  projectId?: string | null;
  identifier?: string | null;
  parentId?: string;
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
}

export interface IssueLink {
  id: string;
  sourceId: string;
  targetId: string;
  linkType: IssueLinkType;
  createdAt: Date;
  createdById?: string | null;
}

export interface Label {
  id: string;
  name: string;
  color: string;
  description?: string;
}

export interface Settings {
  id: string;
  userId: string;
  theme: 'light' | 'dark' | 'system';
  defaultPriority: Priority;
  emailNotifications: boolean;
  createdAt: Date;
  updatedAt: Date;
}
