"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { useWorkspace } from './use-workspace';
import { useProject } from './use-project';
import {
  fetchChatSessions,
  createChatSession,
  archiveChatSession,
  updateChatSession,
  type ChatSession,
} from '@/lib/api/chat';

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

export function ChatSessionsProvider({ children }: { children: ReactNode }) {
  const { activeWorkspace } = useWorkspace();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    if (!activeWorkspace) {
      setSessions([]);
      return;
    }

    setIsLoading(true);
    try {
      const result = await fetchChatSessions(activeWorkspace.id);
      setSessions(result.data);
    } catch {
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const createSessionFn = useCallback(async (projectId?: string): Promise<ChatSession | null> => {
    if (!activeWorkspace) return null;
    try {
      const session = await createChatSession(activeWorkspace.id, projectId);
      setSessions(prev => [session, ...prev]);
      setActiveSessionId(session.id);
      return session;
    } catch {
      return null;
    }
  }, [activeWorkspace]);

  const archiveSessionFn = useCallback(async (id: string) => {
    try {
      await archiveChatSession(id);
      setSessions(prev => prev.filter(s => s.id !== id));
      if (activeSessionId === id) setActiveSessionId(null);
    } catch { /* swallow */ }
  }, [activeSessionId]);

  const renameSession = useCallback(async (id: string, title: string) => {
    try {
      const updated = await updateChatSession(id, { title });
      setSessions(prev => prev.map(s => s.id === id ? { ...s, ...updated } : s));
    } catch { /* swallow */ }
  }, []);

  const refreshSessions = useCallback(async () => {
    await loadSessions();
  }, [loadSessions]);

  return (
    <ChatSessionsContext.Provider value={{
      sessions,
      isLoading,
      activeSessionId,
      setActiveSessionId,
      createSession: createSessionFn,
      archiveSession: archiveSessionFn,
      renameSession,
      refreshSessions,
    }}>
      {children}
    </ChatSessionsContext.Provider>
  );
}

export function useChatSessions() {
  const ctx = useContext(ChatSessionsContext);
  if (!ctx) throw new Error('useChatSessions must be used within ChatSessionsProvider');
  return ctx;
}
