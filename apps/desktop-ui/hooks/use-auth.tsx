"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { User, Repository, fetchCurrentUser, getActiveRepository, logout as apiLogout } from '@/lib/api';

interface AuthContextType {
  user: User | null;
  activeRepository: Repository | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  refreshUser: () => Promise<void>;
  refreshActiveRepository: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [activeRepository, setActiveRepository] = useState<Repository | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const userData = await fetchCurrentUser();
      setUser(userData);
    } catch {
      setUser(null);
    }
  }, []);

  const refreshActiveRepository = useCallback(async () => {
    try {
      const project = await getActiveRepository();
      setActiveRepository(project);
    } catch {
      setActiveRepository(null);
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

    Promise.all([refreshUser(), refreshActiveRepository()]).finally(() => {
      setIsLoading(false);
    });
  }, [refreshUser, refreshActiveRepository]);

  const logout = useCallback(() => {
    apiLogout();
    setUser(null);
    setActiveRepository(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        activeRepository,
        isLoading,
        isAuthenticated: !!user,
        refreshUser,
        refreshActiveRepository,
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
