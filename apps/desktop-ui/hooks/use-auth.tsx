"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import {
  User,
  Repository,
  fetchCurrentUser,
  getActiveRepository,
  logout as apiLogout,
  verifyCallbackToken,
} from '@/lib/api';

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

type AuthCallbackPayload = {
  success: boolean;
  token?: string;
  error?: string;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [activeRepository, setActiveRepository] = useState<Repository | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const authRequestId = useRef(0);

  const loadUser = useCallback(async (): Promise<{ stale: boolean; user: User | null }> => {
    const requestId = ++authRequestId.current;
    try {
      const userData = await fetchCurrentUser();
      if (requestId !== authRequestId.current) {
        return { stale: true, user: null };
      }
      setUser(userData);
      return { stale: false, user: userData };
    } catch {
      if (requestId !== authRequestId.current) {
        return { stale: true, user: null };
      }
      setUser(null);
      return { stale: false, user: null };
    }
  }, []);

  const refreshUser = useCallback(async () => {
    await loadUser();
  }, [loadUser]);

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

    (async () => {
      const result = await loadUser();
      if (result.stale) return;
      if (result.user) {
        await refreshActiveRepository();
      }
      if (!result.stale) {
        setIsLoading(false);
      }
    })();
  }, [loadUser, refreshActiveRepository]);

  const handleAuthCallback = useCallback(async (payload: AuthCallbackPayload) => {
    if (payload.success && payload.token) {
      setIsLoading(true);
      setActiveRepository(null);

      const requestId = ++authRequestId.current;
      try {
        const userData = await verifyCallbackToken(payload.token);
        if (requestId !== authRequestId.current) return;
        setUser(userData);
        await refreshActiveRepository();
        if (pathname === '/login') {
          router.replace('/');
        }
      } catch (err) {
        console.warn('[Auth] Failed to verify Tauri callback token:', err);
        toast.error('Could not finish GitHub sign-in. Paste the callback token from the browser page.');
      } finally {
        if (requestId === authRequestId.current) {
          setIsLoading(false);
        }
      }
    } else if (payload.error) {
      console.error('[Auth] Tauri callback error:', payload.error);
    }
  }, [pathname, refreshActiveRepository, router]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('__TAURI_INTERNALS__' in window)) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const { invoke } = await import('@tauri-apps/api/core');
        const dispose = await listen<AuthCallbackPayload>('auth:callback', (event) => {
          void handleAuthCallback(event.payload);
          void invoke('consume_pending_auth_callback').catch(() => null);
        });
        if (cancelled) {
          dispose();
        } else {
          unlisten = dispose;
        }
        const pending = await invoke<AuthCallbackPayload | null>('consume_pending_auth_callback').catch(() => null);
        if (!cancelled && pending) {
          void handleAuthCallback(pending);
        }
      } catch (err) {
        console.warn('[Auth] Failed to register Tauri auth:callback listener:', err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleAuthCallback]);

  const logout = useCallback(() => {
    apiLogout();
    setUser(null);
    setActiveRepository(null);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleAuthExpired = () => {
      setUser(null);
      setActiveRepository(null);
      toast.error('Session expired. Please sign in again.');
      if (pathname !== '/login' && pathname !== '/') {
        router.push('/login');
      }
    };

    window.addEventListener('auth:expired', handleAuthExpired);
    return () => window.removeEventListener('auth:expired', handleAuthExpired);
  }, [router, pathname]);

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
