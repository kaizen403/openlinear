"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useWorkspace } from './use-workspace';
import {
  createChatSession,
  archiveChatSession,
  updateChatSession,
  type ChatSession,
} from '@/lib/api/chat';
import { queryKeys } from '@/lib/query/keys';
import { chatSessionsQuery } from '@/lib/query/resources';
import { useAppQueryClient } from '@/lib/query/use-app-query-client';

interface ChatSessionsContextValue {
  sessions: ChatSession[];
  isLoading: boolean;
  activeSessionId: string | null;
  setActiveSessionId: (id: string | null) => void;
  createSession: (projectId?: string) => Promise<ChatSession | null>;
  archiveSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
}

const ChatSessionsContext = createContext<ChatSessionsContextValue | null>(null);
const NO_SESSIONS: ChatSession[] = [];

/**
 * The chat session list lives in the query cache
 * (`queryKeys.workspaces.chatSessions`); `chat:session:updated` events (e.g.
 * the server's auto-title) patch it through the SSE bridge. Message streaming
 * stays in `useChatStream`.
 */
export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const { activeWorkspace } = useWorkspace();
  const workspaceId = activeWorkspace?.id;
  const client = useAppQueryClient();
  const { data, isLoading } = useQuery({ ...chatSessionsQuery(workspaceId ?? ''), enabled: Boolean(workspaceId) }, client);
  const sessions = (workspaceId ? data : undefined) ?? NO_SESSIONS;
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const updateSessions = useCallback((update: (prev: ChatSession[]) => ChatSession[]) => {
    if (!workspaceId) return;
    client.setQueryData<ChatSession[]>(queryKeys.workspaces.chatSessions(workspaceId), (prev) => update(prev ?? []));
  }, [client, workspaceId]);

  const createSessionFn = useCallback(async (projectId?: string): Promise<ChatSession | null> => {
    if (!workspaceId) return null;
    try {
      const session = await createChatSession(workspaceId, projectId);
      updateSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
      setActiveSessionId(session.id);
      return session;
    } catch {
      return null;
    }
  }, [updateSessions, workspaceId]);

  const archiveSessionFn = useCallback(async (id: string) => {
    try {
      await archiveChatSession(id);
      updateSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveSessionId((current) => (current === id ? null : current));
    } catch { /* swallow */ }
  }, [updateSessions]);

  const renameSession = useCallback(async (id: string, title: string) => {
    try {
      const updated = await updateChatSession(id, { title });
      updateSessions((prev) => prev.map((s) => (s.id === id ? { ...s, ...updated } : s)));
    } catch { /* swallow */ }
  }, [updateSessions]);

  const refreshSessions = useCallback(async () => {
    if (!workspaceId) return;
    try {
      await client.query({ ...chatSessionsQuery(workspaceId), staleTime: 0 });
    } catch {
      updateSessions(() => []);
    }
  }, [client, updateSessions, workspaceId]);

  const value = useMemo(() => ({
    sessions,
    isLoading,
    activeSessionId,
    setActiveSessionId,
    createSession: createSessionFn,
    archiveSession: archiveSessionFn,
    renameSession,
    refreshSessions,
  }), [sessions, isLoading, activeSessionId, createSessionFn, archiveSessionFn, renameSession, refreshSessions]);

  return (
    <ChatSessionsContext.Provider value={value}>
      {children}
    </ChatSessionsContext.Provider>
  );
}

export function useChatSessions() {
  const ctx = useContext(ChatSessionsContext);
  if (!ctx) throw new Error('useChatSessions must be used within ChatSessionsProvider');
  return ctx;
}
