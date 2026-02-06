"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { User, Project, fetchCurrentUser, getActiveProject, logout as apiLogout } from '@/lib/api';

interface AuthContextType {
  user: User | null;
  activeProject: Project | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  refreshUser: () => Promise<void>;
  refreshActiveProject: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const userData = await fetchCurrentUser();
      setUser(userData);
    } catch {
      setUser(null);
    }
  }, []);

  const refreshActiveProject = useCallback(async () => {
    try {
      const project = await getActiveProject();
      setActiveProject(project);
    } catch {
      setActiveProject(null);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const error = params.get('error');

    if (token) {
      localStorage.setItem('token', token);
      window.history.replaceState({}, '', window.location.pathname);
    }

    if (error) {
      console.error('Auth error:', error);
      window.history.replaceState({}, '', window.location.pathname);
    }

    Promise.all([refreshUser(), refreshActiveProject()]).finally(() => {
      setIsLoading(false);
    });
  }, [refreshUser, refreshActiveProject]);

  const logout = useCallback(() => {
    apiLogout();
    setUser(null);
    setActiveProject(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        activeProject,
        isLoading,
        isAuthenticated: !!user,
        refreshUser,
        refreshActiveProject,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
