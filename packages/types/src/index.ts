export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

export type Priority = 'low' | 'medium' | 'high';

export interface Task {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: Priority;
  labels: string[];
  assigneeId?: string;
  projectId?: string;
  parentId?: string;
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
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
