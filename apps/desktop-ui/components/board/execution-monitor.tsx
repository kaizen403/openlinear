"use client";

import { useState, useEffect } from 'react';
import { Loader2, GitBranch, Code, GitPullRequest, Check, X, ExternalLink } from 'lucide-react';
import { cn, openExternal } from '@/lib/utils';

interface ExecutionProgress {
  taskId: string;
  status: 'cloning' | 'executing' | 'committing' | 'creating_pr' | 'done' | 'cancelled' | 'error';
  message: string;
  prUrl?: string;
}

interface ExecutionMonitorProps {
  taskId: string;
  progress: ExecutionProgress | null;
}

const statusConfig = {
  cloning: { icon: GitBranch, label: 'Cloning repository', color: 'text-blue-400' },
  executing: { icon: Code, label: 'Running OpenCode', color: 'text-linear-accent' },
  committing: { icon: GitBranch, label: 'Committing changes', color: 'text-yellow-400' },
  creating_pr: { icon: GitPullRequest, label: 'Creating PR', color: 'text-purple-400' },
  done: { icon: Check, label: 'Complete', color: 'text-green-400' },
  cancelled: { icon: X, label: 'Cancelled', color: 'text-gray-400' },
  error: { icon: X, label: 'Error', color: 'text-red-400' },
};

export function ExecutionMonitor({ taskId, progress }: ExecutionMonitorProps) {
  if (!progress || progress.taskId !== taskId) {
    return null;
  }

  const config = statusConfig[progress.status];
  const Icon = config.icon;
  const isActive = ['cloning', 'executing', 'committing', 'creating_pr'].includes(progress.status);

  return (
    <div className="mt-2 p-2 bg-linear-bg-tertiary rounded-md">
      <div className="flex items-center gap-2">
        {isActive ? (
          <Loader2 className={cn('w-3 h-3 animate-spin', config.color)} />
        ) : (
          <Icon className={cn('w-3 h-3', config.color)} />
        )}
        <span className="text-xs text-linear-text-secondary">
          {progress.message || config.label}
        </span>
      </div>
      
      {progress.prUrl && (
        <button
          className="flex items-center gap-1 mt-2 text-xs text-linear-accent hover:underline"
          onClick={(e) => { e.stopPropagation(); openExternal(progress.prUrl!) }}
        >
          <ExternalLink className="w-3 h-3" />
          View Pull Request
        </button>
      )}
    </div>
  );
}
