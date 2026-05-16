"use client";

import { Github, LogOut } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { startLogin } from '@/lib/api';

export function UserMenu() {
  const { user, isLoading, isAuthenticated, logout } = useAuth();

  if (isLoading) {
    return (
      <div className="w-8 h-8 rounded-full bg-linear-bg-tertiary animate-pulse" />
    );
  }

  if (!isAuthenticated) {
    return (
      <button
        type="button"
        onClick={() => void startLogin()}
        className="flex items-center gap-2 h-9 px-4 rounded-sm bg-linear-bg-tertiary hover:bg-linear-border text-sm font-medium transition-colors"
      >
        <Github className="w-4 h-4" />
        Sign in with GitHub
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        {user?.avatarUrl && (
          <img
            src={user.avatarUrl}
            alt={user.username}
            className="w-8 h-8 rounded-full object-cover ring-1 ring-linear-border"
          />
        )}
        <span className="text-sm font-medium">{user?.username}</span>
      </div>
      <button
        onClick={logout}
        className="p-2 rounded-sm hover:bg-linear-bg-tertiary transition-colors"
        title="Sign out"
      >
        <LogOut className="w-4 h-4 text-linear-text-secondary" />
      </button>
    </div>
  );
}
