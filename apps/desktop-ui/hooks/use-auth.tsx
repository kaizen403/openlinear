"use client";

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { User, Repository, fetchCurrentUser, getActiveRepository, logout as apiLogout } from '@/lib/api';
import { toast } from 'sonner';

async function storeGitHubAccessToken(accessToken?: string) {
  if (!accessToken || typeof window === 'undefined' || !("__TAURI_INTERNALS__" in window)) {
    return;
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('store_secret', { key: 'github_token', value: accessToken });
  } catch (error) {
    console.error('Failed to store GitHub token:', error);
  }
}

interface AuthCallbackPayload {
  success: boolean;
  token?: string;
  github_connect_token?: string;
  error?: string;
}

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
    const githubConnectToken = params.get('github_connect_token');
    const error = params.get('error');

    if (githubConnectToken) {
      import('@/lib/api/auth').then(({ confirmGitHubConnect }) => {
        confirmGitHubConnect(githubConnectToken)
          .then(async (res) => {
            await storeGitHubAccessToken(res.githubAccessToken)
            localStorage.setItem('token', res.token);
            window.history.replaceState({}, '', window.location.pathname);
            await Promise.all([refreshUser(), refreshActiveRepository()]);
          })
          .catch(err => {
            console.error('GitHub connect error:', err);
            toast.error(err instanceof Error ? err.message : 'GitHub connection failed');
          });
      }).catch(err => console.error('Failed to load auth module:', err));
    } else if (token) {
      localStorage.setItem('token', token);
      window.history.replaceState({}, '', window.location.pathname);
    }

    if (error) {
      console.error('Auth error:', error);
      toast.error(error);
      window.history.replaceState({}, '', window.location.pathname);
    }

    Promise.all([refreshUser(), refreshActiveRepository()]).finally(() => {
      setIsLoading(false);
    });
  }, [refreshUser, refreshActiveRepository]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const subscribe = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlisten = await listen<AuthCallbackPayload>('auth:callback', async (event) => {
          const payload = event.payload;

          if (payload.success) {
            if (payload.github_connect_token) {
              try {
                const { confirmGitHubConnect } = await import('@/lib/api/auth');
                const res = await confirmGitHubConnect(payload.github_connect_token);
                await storeGitHubAccessToken(res.githubAccessToken)
                localStorage.setItem('token', res.token);
                await Promise.all([refreshUser(), refreshActiveRepository()]);
              } catch (e) {
                console.error('GitHub connect error via callback:', e);
                toast.error(e instanceof Error ? e.message : 'GitHub connection failed');
              }
              return;
            } else if (payload.token) {
              localStorage.setItem('token', payload.token);
              await Promise.all([refreshUser(), refreshActiveRepository()]);
              return;
            }
          }

          if (payload.error) {
            console.error('Auth callback error:', payload.error);
            toast.error(payload.error);
          }
        });
      } catch {}
    };

    void subscribe();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
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
