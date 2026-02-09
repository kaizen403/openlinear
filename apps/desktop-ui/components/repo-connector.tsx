"use client";

import { useState, useEffect, useCallback } from 'react';
import { GitBranch, Check, Loader2, Link as LinkIcon, X } from 'lucide-react';
import { PublicProject, addRepoByUrl, getActivePublicProject } from '@/lib/api';

interface RepoConnectorProps {
  onRepoConnected?: (project: PublicProject) => void;
  onRepoDisconnected?: () => void;
}

export function RepoConnector({ onRepoConnected, onRepoDisconnected }: RepoConnectorProps) {
  const [url, setUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectedProject, setConnectedProject] = useState<PublicProject | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);

  const checkActiveProject = useCallback(async () => {
    try {
      const project = await getActivePublicProject();
      setConnectedProject(project);
      if (project && onRepoConnected) {
        onRepoConnected(project);
      }
    } catch {
      setConnectedProject(null);
    }
  }, [onRepoConnected]);

  useEffect(() => {
    checkActiveProject();
  }, [checkActiveProject]);

  const handleConnect = async () => {
    if (!url.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const project = await addRepoByUrl(url.trim());
      setConnectedProject(project);
      setUrl('');
      setIsExpanded(false);
      if (onRepoConnected) {
        onRepoConnected(project);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect repository');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDisconnect = () => {
    setConnectedProject(null);
    setIsExpanded(true);
    if (onRepoDisconnected) {
      onRepoDisconnected();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isLoading) {
      handleConnect();
    }
    if (e.key === 'Escape') {
      setIsExpanded(false);
      setUrl('');
      setError(null);
    }
  };

  if (connectedProject) {
    return (
      <div className="flex items-center gap-2">
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-md border"
          style={{
            backgroundColor: 'color-mix(in srgb, var(--linear-accent) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--linear-accent) 20%, transparent)',
          }}
        >
          <Check className="w-3.5 h-3.5 text-linear-accent" />
          <span className="text-sm text-linear-accent font-medium">
            {connectedProject.fullName}
          </span>
          <button
            onClick={handleDisconnect}
            className="ml-1 p-0.5 rounded transition-colors hover:bg-linear-bg-tertiary"
            title="Disconnect repository"
          >
            <X className="w-3 h-3 text-linear-accent" />
          </button>
        </div>
      </div>
    );
  }

  if (!isExpanded) {
    return (
      <button
        onClick={() => setIsExpanded(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-linear-bg-tertiary hover:bg-linear-border text-sm text-linear-text-secondary transition-colors"
      >
        <LinkIcon className="w-3.5 h-3.5" />
        <span>Connect Repo</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="relative flex-1 min-w-[200px]">
        <GitBranch className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-linear-text-tertiary" />
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="github.com/owner/repo"
          className="w-full h-8 pl-9 pr-3 rounded-md bg-linear-bg-tertiary border border-linear-border text-sm placeholder:text-linear-text-tertiary focus:outline-none focus:border-linear-accent transition-colors"
          autoFocus
          disabled={isLoading}
        />
      </div>
      <button
        onClick={handleConnect}
        disabled={isLoading || !url.trim()}
        className="h-8 px-3 rounded-md bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          'Connect'
        )}
      </button>
      <button
        onClick={() => {
          setIsExpanded(false);
          setUrl('');
          setError(null);
        }}
        className="h-8 px-2 rounded-md hover:bg-linear-bg-tertiary text-linear-text-secondary transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
      {error && (
        <span className="text-xs text-red-400">{error}</span>
      )}
    </div>
  );
}
