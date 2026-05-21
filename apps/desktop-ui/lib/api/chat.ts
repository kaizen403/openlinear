import { apiFetch } from './fetch';
import { getApiUrl, getAuthHeader } from './client';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatSession {
  id: string;
  userId: string;
  workspaceId: string;
  projectId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string | null;
  _count?: { messages: number };
}

export type ChatMessageRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string | null;
  toolCalls: ToolCall[] | null;
  toolCallId: string | null;
  name: string | null;
  createdAt: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatChunkType =
  | 'assistant_delta'
  | 'tool_call_start'
  | 'tool_result'
  | 'assistant_final'
  | 'done'
  | 'error';

export interface ChatChunk {
  type: ChatChunkType;
  /** Text delta for assistant_delta */
  content?: string;
  /** Tool call metadata for tool_call_start */
  toolCall?: { id: string; name: string; arguments: string };
  /** Tool result for tool_result */
  toolResult?: { toolCallId: string; name: string; content: string; isError?: boolean };
  /** Final assembled message for assistant_final */
  message?: ChatMessage;
  /** Error info for error chunks */
  error?: { code: string; message: string };
  /** Usage stats for done chunks */
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

// ─── Session CRUD ────────────────────────────────────────────────────────────

export async function fetchChatSessions(workspaceId: string, cursor?: string): Promise<{ data: ChatSession[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ workspaceId });
  if (cursor) params.set('cursor', cursor);
  return apiFetch<{ data: ChatSession[]; nextCursor: string | null }>(`/api/chat/sessions?${params}`);
}

export async function createChatSession(workspaceId: string, projectId?: string): Promise<ChatSession> {
  return apiFetch<ChatSession>('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspaceId, projectId }),
  });
}

export async function fetchChatSession(sessionId: string, before?: string): Promise<ChatSession & { messages: ChatMessage[] }> {
  const params = before ? `?before=${before}` : '';
  return apiFetch<ChatSession & { messages: ChatMessage[] }>(`/api/chat/sessions/${sessionId}${params}`);
}

export async function updateChatSession(sessionId: string, data: { title?: string; projectId?: string | null }): Promise<ChatSession> {
  return apiFetch<ChatSession>(`/api/chat/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function archiveChatSession(sessionId: string): Promise<void> {
  await apiFetch(`/api/chat/sessions/${sessionId}`, { method: 'DELETE' });
}

// ─── Streaming Message Send ──────────────────────────────────────────────────

export interface SendMessageOptions {
  sessionId: string;
  content: string;
  signal?: AbortSignal;
  onChunk: (chunk: ChatChunk) => void;
  onError?: (error: Error) => void;
  onDone?: () => void;
}

/**
 * Sends a message and consumes the SSE stream of ChatChunks.
 * Uses raw fetch (not apiFetch) because we need streaming response.
 */
export async function sendChatMessage({ sessionId, content, signal, onChunk, onError, onDone }: SendMessageOptions): Promise<void> {
  const url = `${getApiUrl()}/api/chat/sessions/${sessionId}/messages`;
  const authHeader = getAuthHeader();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authHeader && typeof authHeader === 'object' && !Array.isArray(authHeader)) {
    Object.assign(headers, authHeader);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'Unknown error');
    const err = new Error(`Chat request failed: ${response.status} ${text}`);
    onError?.(err);
    return;
  }

  if (!response.body) {
    onError?.(new Error('No response body'));
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          onDone?.();
          return;
        }
        try {
          const chunk: ChatChunk = JSON.parse(data);
          onChunk(chunk);
          if (chunk.type === 'done') {
            onDone?.();
            return;
          }
          if (chunk.type === 'error') {
            onError?.(new Error(chunk.error?.message || 'Stream error'));
            return;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
    onDone?.();
  } catch (err) {
    if (signal?.aborted) return;
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}
