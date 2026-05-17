import { apiFetch } from './fetch';
import type { TeamMember } from './types';

export interface CommentAuthor {
  id: string;
  username: string;
  avatarUrl: string | null;
}

export interface Comment {
  id: string;
  taskId: string;
  userId: string;
  body: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
  user: CommentAuthor;
}

export interface CommentListResponse {
  comments: Comment[];
  page: number;
  pageSize: number;
  total: number;
}

export interface TaskWithTeam {
  id: string;
  teamId: string | null;
  title: string;
}

const COMMENTS_PAGE_SIZE = 100;

export async function fetchComments(taskId: string): Promise<CommentListResponse> {
  const firstPage = await fetchCommentsPage(taskId, 1);
  if (firstPage.comments.length >= firstPage.total) return firstPage;

  const allComments = [...firstPage.comments];
  let page = firstPage.page + 1;

  while (allComments.length < firstPage.total) {
    const nextPage = await fetchCommentsPage(taskId, page);
    if (nextPage.comments.length === 0) break;
    allComments.push(...nextPage.comments);
    page += 1;
  }

  return {
    ...firstPage,
    comments: allComments,
    page: 1,
    pageSize: COMMENTS_PAGE_SIZE,
  };
}

function fetchCommentsPage(taskId: string, page: number): Promise<CommentListResponse> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(COMMENTS_PAGE_SIZE),
  });
  return apiFetch<CommentListResponse>(`/api/tasks/${taskId}/comments?${params.toString()}`);
}

export async function createComment(taskId: string, body: string): Promise<Comment> {
  return apiFetch<Comment>(`/api/tasks/${taskId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export async function updateComment(commentId: string, body: string): Promise<Comment> {
  return apiFetch<Comment>(`/api/comments/${commentId}`, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
}

export async function deleteComment(commentId: string): Promise<void> {
  await apiFetch<void>(`/api/comments/${commentId}`, { method: 'DELETE' });
}

/**
 * Fetch a single task to discover its teamId for member autocomplete scoping.
 * Returned shape includes more fields server-side; we only type what we use here.
 */
export async function fetchTaskTeamId(taskId: string): Promise<TaskWithTeam> {
  return apiFetch<TaskWithTeam>(`/api/tasks/${taskId}`);
}

export async function fetchTeamMembers(teamId: string): Promise<TeamMember[]> {
  return apiFetch<TeamMember[]>(`/api/teams/${teamId}/members`);
}
