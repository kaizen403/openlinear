"use client";

import { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import {
  User,
  Repository,
  completeDesktopLogin,
  DesktopLoginError,
  fetchCurrentUser,
  getActiveRepository,
  logout as apiLogout,
  type DesktopCallback,
  type DesktopLoginResult,
} from '@/lib/api';
import { initTokenStore } from '@/lib/api/token-store';
import { isDesktopRuntime } from '@/lib/api/runtime';

interface AuthContextType {
  user: User | null;
  activeRepository: Repository | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Set when a desktop sign-in needs a TOTP code to finish. */
  pendingTwoFactorToken: string | null;
  clearPendingTwoFactor: () => void;
  /** Finish a desktop sign-in from an `openlinear://callback` deep link (or pasted copy). */
  completeDesktopCallback: (callback: DesktopCallback) => Promise<DesktopLoginResult>;
  refreshUser: () => Promise<void>;
  refreshActiveRepository: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Emitted by apps/desktop/src-tauri/src/deeplink.rs for `openlinear://callback`.
 * Carries a one-time code and the state this app generated — never a token.
 */
type AuthCallbackPayload = {
  success: boolean;
  code?: string;
  state?: string;
  error?: string;
  /** Older shells forwarded a token; such payloads are ignored. */
  token?: string;
};

function toDesktopCallback(payload: AuthCallbackPayload): DesktopCallback | null {
  if (payload.error) {
    return { kind: 'error', error: payload.error, state: payload.state ?? null };
  }
  if (payload.success && payload.code && payload.state) {
    return { kind: 'code', code: payload.code, state: payload.state };
  }
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [activeRepository, setActiveRepository] = useState<Repository | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingTwoFactorToken, setPendingTwoFactorToken] = useState<string | null>(null);
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

  // Note: this used to also read a `?token=` query param here and adopt it
  // into storage on ANY route — since this effect runs app-wide (AuthProvider
  // wraps the whole app), a link like `https://app/anything?token=<jwt>`
  // would silently swap the victim's session to whoever crafted the link.
  // `?token=` is now only ever handled by the dedicated `/auth/session`
  // route (see app/auth/session/page.tsx), which explicitly verifies the
  // token against the API before adopting it.
  useEffect(() => {
    (async () => {
      await initTokenStore();
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

  const completeDesktopCallback = useCallback(async (callback: DesktopCallback): Promise<DesktopLoginResult> => {
    const requestId = ++authRequestId.current;
    setIsLoading(true);
    try {
      const result = await completeDesktopLogin(callback);
      if (result.status === 'two_factor_required') {
        setPendingTwoFactorToken(result.tempToken);
        return result;
      }
      if (requestId === authRequestId.current) {
        setPendingTwoFactorToken(null);
        setActiveRepository(null);
        setUser(result.user);
        await refreshActiveRepository();
      }
      return result;
    } finally {
      if (requestId === authRequestId.current) {
        setIsLoading(false);
      }
    }
  }, [refreshActiveRepository]);

  const handleAuthCallback = useCallback(async (payload: AuthCallbackPayload) => {
    const callback = toDesktopCallback(payload);
    if (!callback) {
      if (payload.token) {
        console.warn('[Auth] Ignored a sign-in deep link that carried a token; tokens are only accepted from the token endpoint.');
      }
      return;
    }
    try {
      const result = await completeDesktopCallback(callback);
      if (result.status === 'two_factor_required') {
        toast.info('Enter your two-factor code to finish signing in.');
        router.replace('/login');
        return;
      }
      toast.success('Authenticated. Opening OpenLinear...');
      if (pathname === '/login' || pathname === '/login/') {
        router.replace('/');
      }
    } catch (err) {
      if (err instanceof DesktopLoginError && err.reason === 'unsolicited') {
        // Not a sign-in this app started (stale or crafted link): drop it.
        console.warn('[Auth] Ignored an unsolicited sign-in callback.');
        return;
      }
      console.warn('[Auth] Desktop sign-in failed:', err);
      toast.error(err instanceof DesktopLoginError ? err.message : 'Could not finish GitHub sign-in. Try signing in again.');
    }
  }, [completeDesktopCallback, pathname, router]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const setupTauri = async () => {
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
    };

    if (isDesktopRuntime()) {
      void setupTauri();
    }

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleAuthCallback]);

  const logout = useCallback(() => {
    apiLogout();
    setUser(null);
    setActiveRepository(null);
    setPendingTwoFactorToken(null);
  }, []);

  const clearPendingTwoFactor = useCallback(() => {
    setPendingTwoFactorToken(null);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleAuthExpired = () => {
      setUser(null);
      setActiveRepository(null);
      toast.error('Session expired. Please sign in again.');
      if (pathname !== '/login' && pathname !== '/login/' && pathname !== '/') {
        router.push('/login/');
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
        pendingTwoFactorToken,
        clearPendingTwoFactor,
        completeDesktopCallback,
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
