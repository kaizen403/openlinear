"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { useWorkspace } from './use-workspace';
import { useProject } from './use-project';

export type ChatScope = 'workspace' | 'project';

interface ChatScopeContextValue {
  scope: ChatScope;
  setScope: (scope: ChatScope) => void;
  scopeWorkspaceId: string | null;
  scopeProjectId: string | null;
}

const ChatScopeContext = createContext<ChatScopeContextValue | null>(null);

export function ChatScopeProvider({ children }: { children: ReactNode }) {
  const { activeWorkspace } = useWorkspace();
  const { activeProject } = useProject();
  const [scope, setScope] = useState<ChatScope>('workspace');

  const scopeWorkspaceId = activeWorkspace?.id || null;
  const scopeProjectId = scope === 'project' ? (activeProject?.id || null) : null;

  return (
    <ChatScopeContext.Provider value={{ scope, setScope, scopeWorkspaceId, scopeProjectId }}>
      {children}
    </ChatScopeContext.Provider>
  );
}

export function useChatScope() {
  const ctx = useContext(ChatScopeContext);
  if (!ctx) throw new Error('useChatScope must be used within ChatScopeProvider');
  return ctx;
}
