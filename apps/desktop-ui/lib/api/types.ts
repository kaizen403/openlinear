export interface User {
  id: string;
  githubId: number;
  username: string;
  email: string | null;
  avatarUrl: string | null;
  repositories: Repository[];
}

export interface Repository {
  id: string;
  githubRepoId: number;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isActive: boolean;
  userId: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  clone_url: string;
  default_branch: string;
  private: boolean;
  description: string | null;
}

export interface PublicRepository {
  id: string;
  githubRepoId: number;
  name: string;
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  isActive: boolean;
  userId: string | null;
}

export interface Team {
  id: string
  name: string
  key: string
  description: string | null
  color: string
  icon: string | null
  private: boolean
  inviteCode: string | null
  nextIssueNumber: number
  createdAt: string
  updatedAt: string
  _count?: { members: number }
  members?: TeamMember[]
  projectTeams?: { project: { id: string; name: string; status: string; color: string; icon: string | null } }[]
}

export interface TeamMember {
  id: string
  teamId: string
  userId: string
  role: 'owner' | 'admin' | 'member'
  sortOrder: number
  createdAt: string
  user?: {
    id: string
    username: string
    email: string | null
    avatarUrl: string | null
  }
}

export interface Project {
  id: string
  name: string
  description: string | null
  status: 'planned' | 'in_progress' | 'paused' | 'completed' | 'cancelled'
  color: string
  icon: string | null
  startDate: string | null
  targetDate: string | null
  leadId: string | null
  repoUrl: string | null
  localPath: string | null
  repositoryId: string | null
  repository?: {
    id: string
    name: string
    fullName: string
    cloneUrl: string
    defaultBranch: string
  } | null
  createdAt: string
  updatedAt: string
  teams?: Team[]
  _count?: { tasks: number }
}

export interface InboxCount {
  total: number
  unread: number
}

export interface InboxTask {
  id: string
  title: string
  description: string | null
  priority: 'low' | 'medium' | 'high'
  status: 'done' | 'cancelled'
  createdAt: string
  updatedAt: string
  prUrl: string | null
  outcome: string | null
  batchId: string | null
  inboxRead: boolean
  executionElapsedMs: number
  labels: Array<{ id: string; name: string; color: string; priority: number }>
  team?: { id: string; name: string; key: string; color: string } | null
  project?: { id: string; name: string; status: string; color: string } | null
  identifier?: string | null
}
