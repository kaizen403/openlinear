"use client";

import { useState, useEffect } from 'react';
import { GitBranch, Plus, Check, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Repository, GitHubRepo, fetchGitHubRepos, importRepo, activateRepository } from '@/lib/api';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

export function ProjectSelector() {
  const { user, activeRepository, isAuthenticated, refreshActiveRepository } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [importing, setImporting] = useState<number | null>(null);

  useEffect(() => {
    if (isOpen && isAuthenticated) {
      setIsLoading(true);
      fetchGitHubRepos()
        .then(setRepos)
        .catch(() => setRepos([]))
        .finally(() => setIsLoading(false));
    }
  }, [isOpen, isAuthenticated]);

  if (!isAuthenticated) {
    return null;
  }

  const handleImport = async (repo: GitHubRepo) => {
    setImporting(repo.id);
    try {
      await importRepo(repo);
      await refreshActiveRepository();
      setIsOpen(false);
    } catch (err) {
      console.error('Failed to import repo:', err);
    } finally {
      setImporting(null);
    }
  };

  const handleActivate = async (project: Repository) => {
    try {
      await activateRepository(project.id);
      await refreshActiveRepository();
      setIsOpen(false);
    } catch (err) {
      console.error('Failed to activate project:', err);
    }
  };

  const userProjects = user?.repositories || [];
  const importedRepoIds = new Set(userProjects.map(p => p.githubRepoId));

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <button className="flex items-center gap-2 px-3 py-2 rounded-md bg-linear-bg-tertiary hover:bg-linear-border text-sm transition-colors w-full">
          <GitBranch className="w-4 h-4 text-linear-text-secondary" />
          <span className="flex-1 text-left truncate">
            {activeRepository?.fullName || 'Select Project'}
          </span>
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Select Project</DialogTitle>
        </DialogHeader>
        
        {userProjects.length > 0 && (
          <div className="mb-4">
            <h3 className="text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider mb-2">
              Your Projects
            </h3>
            <div className="space-y-1">
              {userProjects.map((project) => (
                <button
                  key={project.id}
                  onClick={() => handleActivate(project)}
                  className="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-linear-bg-tertiary transition-colors text-left"
                >
                  <GitBranch className="w-4 h-4 text-linear-text-secondary" />
                  <span className="flex-1 truncate">{project.fullName}</span>
                  {project.isActive && (
                    <Check className="w-4 h-4 text-green-500" />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-xs font-semibold text-linear-text-tertiary uppercase tracking-wider mb-2">
            Import from GitHub
          </h3>
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-linear-text-secondary" />
            </div>
          ) : (
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {repos.map((repo) => {
                const isImported = importedRepoIds.has(repo.id);
                const isImporting = importing === repo.id;
                
                return (
                  <div
                    key={repo.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-linear-bg-tertiary transition-colors"
                  >
                    <GitBranch className="w-4 h-4 text-linear-text-secondary" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{repo.full_name}</div>
                      {repo.description && (
                        <div className="truncate text-xs text-linear-text-tertiary">
                          {repo.description}
                        </div>
                      )}
                    </div>
                    {isImported ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleImport(repo)}
                        disabled={isImporting}
                      >
                        {isImporting ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
