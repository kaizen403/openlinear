"use client"

import { useState, useCallback, useEffect } from "react"
import { GitBranch, Lock, Loader2, FolderOpen } from "lucide-react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { fetchGitHubRepos, startLogin, type GitHubRepo } from "@/lib/api"
import { toast } from "sonner"
import { mapErrorToForm, type ProjectFormData } from "@/hooks/use-projects"

interface RepoPickerFieldProps {
  formData: ProjectFormData
  setFormData: React.Dispatch<React.SetStateAction<ProjectFormData>>
  isDesktopApp: boolean
  /** Unique prefix for radio name attrs to avoid collisions */
  namePrefix?: string
}

export function RepoPickerField({ formData, setFormData, isDesktopApp, namePrefix = "" }: RepoPickerFieldProps) {
  const [repoMode, setRepoMode] = useState<'url' | 'picker'>('url')
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [repoSearch, setRepoSearch] = useState('')
  const [githubError, setGithubError] = useState<string | null>(null)
  const [isPickingLocalPath, setIsPickingLocalPath] = useState(false)

  const handleGitHubLogin = useCallback(async () => {
    const started = await startLogin()
    if (!started) {
      toast.error("Could not open GitHub sign-in. Check that the desktop API is running and try again.")
    }
  }, [])

  const loadGitHubRepos = useCallback(async () => {
    setReposLoading(true)
    setGithubError(null)
    try {
      const { repos } = await fetchGitHubRepos({ perPage: 100 })
      setGithubRepos(repos)
    } catch {
      setGithubError('Failed to fetch GitHub repos')
    } finally {
      setReposLoading(false)
    }
  }, [])

  const pickLocalFolder = useCallback(async () => {
    if (!isDesktopApp) return
    setIsPickingLocalPath(true)
    try {
      let selectedPath: string | null = null
      const win = window as unknown as Record<string, unknown>
      if (typeof window !== 'undefined' && 'electronAPI' in window && win.electronAPI && (win.electronAPI as { isElectron?: boolean }).isElectron) {
        selectedPath = await (win.electronAPI as { pickFolder: () => Promise<string | null> }).pickFolder()
      } else {
        const { invoke } = await import("@tauri-apps/api/core")
        selectedPath = await invoke<string | null>("pick_local_folder")
      }
      if (!selectedPath) return
      setFormData((prev) => ({ ...prev, sourceType: "local", repoUrl: "", localPath: selectedPath }))
    } catch (error) {
      const { toastMessage } = mapErrorToForm(
        error,
        "Could not open the folder picker. Try again or paste a path manually.",
      )
      toast.error(toastMessage)
    } finally {
      setIsPickingLocalPath(false)
    }
  }, [isDesktopApp, setFormData])

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
          <input
            type="radio"
            name={`${namePrefix}sourceType`}
            value="none"
            checked={formData.sourceType === "none"}
            onChange={() => setFormData(prev => ({ ...prev, sourceType: "none", repoUrl: "", localPath: "" }))}
            className="accent-[var(--linear-accent)]"
          />
          None
        </label>
        <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
          <input
            type="radio"
            name={`${namePrefix}sourceType`}
            value="repo"
            checked={formData.sourceType === "repo"}
            onChange={() => {
              setFormData(prev => ({ ...prev, sourceType: "repo", localPath: "" }))
              setRepoMode('url')
            }}
            className="accent-[var(--linear-accent)]"
          />
          GitHub Repo
        </label>
        {isDesktopApp && (
          <label className="flex items-center gap-2 text-sm text-linear-text-secondary cursor-pointer">
            <input
              type="radio"
              name={`${namePrefix}sourceType`}
              value="local"
              checked={formData.sourceType === "local"}
              onChange={() => setFormData(prev => ({ ...prev, sourceType: "local", repoUrl: "" }))}
              className="accent-[var(--linear-accent)]"
            />
            Local Folder
          </label>
        )}
      </div>

      {!isDesktopApp && (
        <p className="text-xs text-linear-text-tertiary">
          Local folder source selection is available only in the desktop app.
        </p>
      )}

      {formData.sourceType === "repo" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRepoMode('url')}
              className={cn(
                "px-3 py-1.5 rounded-sm text-sm font-medium transition-colors",
                repoMode === 'url'
                  ? "bg-linear-bg-tertiary text-linear-text"
                  : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
              )}
            >
              Enter URL
            </button>
            <button
              type="button"
              onClick={() => {
                setRepoMode('picker')
                if (githubRepos.length === 0 && !githubError) {
                  loadGitHubRepos()
                }
              }}
              className={cn(
                "px-3 py-1.5 rounded-sm text-sm font-medium transition-colors",
                repoMode === 'picker'
                  ? "bg-linear-bg-tertiary text-linear-text"
                  : "text-linear-text-secondary hover:text-linear-text hover:bg-linear-bg-tertiary/50"
              )}
            >
              My Repos
            </button>
          </div>

          {repoMode === 'url' && (
            <Input
              value={formData.repoUrl}
              onChange={(e) => setFormData(prev => ({ ...prev, repoUrl: e.target.value }))}
              placeholder="https://github.com/owner/repo"
              className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
            />
          )}

          {repoMode === 'picker' && (
            <div className="space-y-2">
              {reposLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
                </div>
              ) : githubError ? (
                <div className="text-sm text-linear-text-secondary py-4">
                  Connect your GitHub account to browse repos.{" "}
                  <button
                    type="button"
                    onClick={() => void handleGitHubLogin()}
                    className="text-linear-accent hover:underline"
                  >
                    Connect GitHub
                  </button>
                </div>
              ) : (
                <>
                  <Input
                    value={repoSearch}
                    onChange={(e) => setRepoSearch(e.target.value)}
                    placeholder="Search repositories..."
                    className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
                  />
                  <div className="max-h-[200px] overflow-y-auto space-y-1">
                    {githubRepos
                      .filter(repo =>
                        repo.full_name.toLowerCase().includes(repoSearch.toLowerCase()) ||
                        (repo.description?.toLowerCase() || '').includes(repoSearch.toLowerCase())
                      )
                      .map(repo => (
                        <button
                          key={repo.id}
                          type="button"
                          onClick={() => {
                            setFormData(prev => ({ ...prev, repoUrl: `https://github.com/${repo.full_name}` }))
                            setRepoMode('url')
                          }}
                          className="w-full text-left p-2 rounded-sm hover:bg-linear-bg-tertiary transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <GitBranch className="w-4 h-4 text-linear-text-tertiary" />
                            <span className="text-sm font-medium text-linear-text">{repo.full_name}</span>
                            {repo.private && (
                              <Lock className="w-3 h-3 text-linear-text-tertiary" />
                            )}
                          </div>
                          {repo.description && (
                            <p className="text-xs text-linear-text-secondary ml-6 line-clamp-1">
                              {repo.description}
                            </p>
                          )}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {formData.sourceType === "local" && (
        isDesktopApp ? (
          <div className="flex items-center gap-2">
            <Input
              value={formData.localPath}
              readOnly
              placeholder="Choose a local folder"
              className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary"
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => pickLocalFolder()}
              disabled={isPickingLocalPath}
              className="border-linear-border text-linear-text hover:bg-linear-bg-tertiary"
            >
              {isPickingLocalPath ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <FolderOpen className="w-4 h-4" />
              )}
              Browse
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            <Input
              value={formData.localPath}
              readOnly
              className="bg-linear-bg-tertiary border-linear-border text-linear-text"
            />
            <p className="text-xs text-linear-text-tertiary">
              This local folder was set in the desktop app.
            </p>
          </div>
        )
      )}
    </div>
  )
}
