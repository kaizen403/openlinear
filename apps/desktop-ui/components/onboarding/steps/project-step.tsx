"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FolderKanban,
  GitBranch,
  GitFork,
  Github,
  Globe2,
  Link,
  Loader2,
  Lock,
  Search,
  SquareTerminal,
  X,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { fetchGitHubRepos, type GitHubRepo } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import {
  type ProjectTab,
  type RepoDraft,
  REPO_SEARCH_LIMIT,
  deriveProjectNameFromUrl,
  getDefaultBranchSuggestions,
  getOwnerLogin,
  getRepoSummary,
  getRepoUrl,
  hasRepoSelection,
} from "./onboarding-utils"

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs)
    return () => window.clearTimeout(timeout)
  }, [delayMs, value])
  return debouncedValue
}

const RepoItem = memo(function RepoItem({
  repo,
  isSelected,
  onSelect,
}: {
  repo: GitHubRepo
  isSelected: boolean
  onSelect: (repo: GitHubRepo) => void
}) {
  const owner = getOwnerLogin(repo)

  return (
    <button
      data-testid="onboarding-github-repo-row"
      type="button"
      onClick={() => onSelect(repo)}
      className={`w-full h-16 overflow-hidden flex items-center gap-2.5 px-3 py-1.5 rounded-sm text-left ${
        isSelected
          ? "bg-linear-accent/10 border border-linear-accent/40"
          : "hover:bg-linear-bg-tertiary border border-transparent"
      }`}
      style={{ contain: "layout paint style" }}
    >
      <div className="relative w-7 h-7 rounded-sm border border-linear-border bg-linear-bg-tertiary flex items-center justify-center text-xs font-medium text-linear-text-secondary flex-shrink-0 overflow-hidden">
        {owner[0]?.toUpperCase()}
        {repo.owner?.avatar_url && (
          <img
            src={repo.owner.avatar_url}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={(event) => event.currentTarget.remove()}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium text-linear-text truncate leading-5">{repo.name}</span>
          {repo.private ? (
            <Lock className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
          ) : (
            <Globe2 className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
          )}
          {repo.fork && <GitFork className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />}
        </div>
        <div className="text-xs text-linear-text-tertiary truncate leading-4">{repo.full_name}</div>
        {repo.description && (
          <p className="text-xs text-linear-text-secondary line-clamp-1 leading-4">{repo.description}</p>
        )}
      </div>

      <div
        className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors mt-1 ${
          isSelected ? "border-linear-accent bg-linear-accent" : "border-linear-border"
        }`}
      >
        {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
      </div>
    </button>
  )
})

const GitHubRepoList = memo(function GitHubRepoList({
  selectedRepo,
  onSelectRepo,
}: {
  selectedRepo: GitHubRepo | null
  onSelectRepo: (repo: GitHubRepo | null) => void
}) {
  const { user } = useAuth()
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [search, setSearch] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isLoadingRepos, setIsLoadingRepos] = useState(false)
  const debouncedSearch = useDebouncedValue(search, 300)
  const repoQuery = useMemo(() => {
    const trimmed = debouncedSearch.trim()
    return trimmed.length >= 2 ? trimmed : ""
  }, [debouncedSearch])
  const requestIdRef = useRef(0)
  const repoRequestControllerRef = useRef<AbortController | null>(null)

  const hasGitHub = Boolean(user?.githubLinked ?? user?.githubId)

  const handleSelectRepo = useCallback(
    (repo: GitHubRepo) => {
      onSelectRepo(selectedRepo?.id === repo.id ? null : repo)
    },
    [onSelectRepo, selectedRepo?.id],
  )

  const loadRepos = useCallback(async () => {
    if (!hasGitHub) return
    if (!repoQuery) {
      requestIdRef.current += 1
      repoRequestControllerRef.current?.abort()
      repoRequestControllerRef.current = null
      setRepos([])
      setError(null)
      setIsLoadingRepos(false)
      return
    }

    const requestId = ++requestIdRef.current
    repoRequestControllerRef.current?.abort()
    const controller = new AbortController()
    repoRequestControllerRef.current = controller

    setError(null)
    setIsLoadingRepos(true)

    try {
      const result = await fetchGitHubRepos({
        page: 1,
        perPage: REPO_SEARCH_LIMIT,
        q: repoQuery,
        signal: controller.signal,
      })
      if (requestId !== requestIdRef.current) return
      setRepos(result.repos || [])
    } catch {
      if (controller.signal.aborted) return
      if (requestId !== requestIdRef.current) return
      setError("Failed to load repositories")
    } finally {
      if (repoRequestControllerRef.current === controller) {
        repoRequestControllerRef.current = null
      }
      if (requestId === requestIdRef.current) {
        setIsLoadingRepos(false)
      }
    }
  }, [hasGitHub, repoQuery])

  useEffect(() => {
    return () => {
      requestIdRef.current += 1
      repoRequestControllerRef.current?.abort()
      repoRequestControllerRef.current = null
    }
  }, [])

  useEffect(() => { loadRepos() }, [loadRepos])

  if (!hasGitHub) {
    return (
      <div className="text-center py-6 space-y-2">
        <Github className="w-8 h-8 mx-auto text-linear-text-tertiary" />
        <p className="text-sm text-linear-text-secondary">Connect GitHub in Settings to see your repos.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-linear-text-tertiary" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or owner/repo..."
            className="pl-9 pr-8 h-8 bg-linear-bg-tertiary border-linear-border text-sm"
          />
          {search && search === debouncedSearch && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-1 text-linear-text-tertiary hover:bg-linear-bg-secondary hover:text-linear-text-secondary"
              aria-label="Clear repository search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {search !== debouncedSearch && (
            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-linear-text-tertiary" />
          )}
        </div>
      </div>
      <p className="text-xs text-linear-text-tertiary">
        Search returns the top {REPO_SEARCH_LIMIT} matches. Use owner/repo for an exact match.
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {!repoQuery ? (
        <div className="text-center py-8">
          <p className="text-sm text-linear-text-tertiary">Search by repository name.</p>
        </div>
      ) : isLoadingRepos ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="w-5 h-5 animate-spin text-linear-text-tertiary" />
        </div>
      ) : repos.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-sm text-linear-text-tertiary">No repositories found.</p>
        </div>
      ) : (
        <div
          data-testid="onboarding-github-repo-list"
          className="max-h-44 overflow-y-auto border border-linear-border rounded-sm"
          style={{ contain: "content" }}
        >
          {repos.map((repo) => (
            <RepoItem
              key={repo.id}
              repo={repo}
              isSelected={selectedRepo?.id === repo.id}
              onSelect={handleSelectRepo}
            />
          ))}
        </div>
      )}
    </div>
  )
})

export function ProjectStep({
  projectName,
  repoDraft,
  isCreating,
  isExistingProject = false,
  onProjectNameChange,
  onRepoDraftChange,
  onBack,
  onCreate,
}: {
  projectName: string
  repoDraft: RepoDraft
  isCreating: boolean
  isExistingProject?: boolean
  onProjectNameChange: (name: string) => void
  onRepoDraftChange: (patch: Partial<RepoDraft>) => void
  onBack?: () => void
  onCreate: () => void
}) {
  const [showRepo, setShowRepo] = useState(false)
  const [activeTab, setActiveTab] = useState<ProjectTab>(repoDraft.source)
  const repoSummary = useMemo(() => getRepoSummary(repoDraft), [repoDraft])
  const suggestions = useMemo(
    () => getDefaultBranchSuggestions(repoDraft),
    [repoDraft.defaultBranch, repoDraft.selectedRepo?.default_branch],
  )

  const canCreate = projectName.trim().length > 0

  const handleRepoSelect = useCallback(
    (repo: GitHubRepo | null) => {
      if (!repo) {
        onRepoDraftChange({ selectedRepo: null, repoUrl: "", sshUrl: "" })
        return
      }
      onRepoDraftChange({
        source: "github",
        selectedRepo: repo,
        repoUrl: getRepoUrl(repo),
        sshUrl: repo.ssh_url || "",
        defaultBranch: repo.default_branch || "main",
      })
      if (!projectName.trim()) {
        onProjectNameChange(repo.name)
      }
    },
    [onRepoDraftChange, onProjectNameChange, projectName],
  )

  const handleLinkChange = useCallback(
    (url: string) => {
      const name = deriveProjectNameFromUrl(url)
      onRepoDraftChange({
        source: "link",
        selectedRepo: null,
        repoUrl: url,
        defaultBranch: repoDraft.defaultBranch || "main",
      })
      if (!projectName.trim() && name) {
        onProjectNameChange(name)
      }
    },
    [onRepoDraftChange, onProjectNameChange, projectName, repoDraft.defaultBranch],
  )

  const handleSshChange = useCallback(
    (url: string) => {
      const name = deriveProjectNameFromUrl(url)
      onRepoDraftChange({
        source: "ssh",
        selectedRepo: null,
        sshUrl: url,
        repoUrl: "",
        defaultBranch: repoDraft.defaultBranch || "main",
      })
      if (!projectName.trim() && name) {
        onProjectNameChange(name)
      }
    },
    [onRepoDraftChange, onProjectNameChange, projectName, repoDraft.defaultBranch],
  )

  const tabs: { id: ProjectTab; label: string; icon: typeof Github }[] = [
    { id: "github", label: "GitHub", icon: Github },
    { id: "link", label: "URL", icon: ExternalLink },
    { id: "ssh", label: "SSH", icon: SquareTerminal },
  ]

  return (
    <div className="space-y-4">
      <div className="text-center space-y-1.5">
        <div className="w-10 h-10 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-2">
          <FolderKanban className="w-5 h-5 text-linear-accent" />
        </div>
        <h2 className="text-lg font-semibold text-linear-text">
          {isExistingProject ? "Project is ready" : "Create a project"}
        </h2>
        <p className="text-xs text-linear-text-secondary">
          {isExistingProject
            ? "Finish setup by adding a team for issue keys and ownership."
            : "Projects group your tasks and connect to a code repository."}
        </p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="onboarding-project-name" className="text-xs font-medium text-linear-text-secondary">
          Project name
        </label>
        <Input
          id="onboarding-project-name"
          value={projectName}
          onChange={(e) => onProjectNameChange(e.target.value)}
          placeholder="e.g., Web App"
          disabled={isExistingProject}
          className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9"
        />
      </div>

      {!isExistingProject && (
        <div className="border border-linear-border rounded-sm overflow-hidden">
          <button
            type="button"
            onClick={() => setShowRepo(!showRepo)}
            aria-expanded={showRepo}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-linear-bg-tertiary transition-colors"
          >
            {showRepo ? (
              <ChevronDown className="w-4 h-4 text-linear-text-tertiary" />
            ) : (
              <ChevronRight className="w-4 h-4 text-linear-text-tertiary" />
            )}
            <GitBranch className="w-4 h-4 text-linear-text-secondary" />
            <span className="text-sm text-linear-text-secondary">Connect a repository</span>
            <span className="ml-auto max-w-[220px] truncate text-xs text-linear-text-tertiary">
              {repoSummary ?? "Optional"}
            </span>
          </button>

          {showRepo && (
            <div className="border-t border-linear-border px-3 py-3 space-y-3">
              <div className="grid grid-cols-3 rounded-sm bg-linear-bg-tertiary p-0.5 border border-linear-border">
                {tabs.map((tab) => {
                  const Icon = tab.icon
                  const isActive = activeTab === tab.id
                  return (
                    <button
                      type="button"
                      key={tab.id}
                      onClick={() => {
                        setActiveTab(tab.id)
                        if (tab.id === "github") {
                          onRepoDraftChange({ source: "github", repoUrl: "", sshUrl: "" })
                        } else if (tab.id === "link") {
                          onRepoDraftChange({ source: "link", selectedRepo: null, sshUrl: "" })
                        } else {
                          onRepoDraftChange({ source: "ssh", selectedRepo: null, repoUrl: "" })
                        }
                      }}
                      className={`flex items-center justify-center gap-1.5 h-7 rounded-sm text-xs font-medium transition-all ${
                        isActive
                          ? "bg-linear-bg-secondary text-linear-text shadow-sm"
                          : "text-linear-text-tertiary hover:text-linear-text-secondary"
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  )
                })}
              </div>

              {activeTab === "github" ? (
                <GitHubRepoList selectedRepo={repoDraft.selectedRepo} onSelectRepo={handleRepoSelect} />
              ) : activeTab === "link" ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-linear-text-secondary">Repository URL</label>
                  <div className="relative">
                    <Link className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-linear-text-tertiary" />
                    <Input
                      value={repoDraft.repoUrl}
                      onChange={(e) => handleLinkChange(e.target.value)}
                      placeholder="https://github.com/owner/repo"
                      className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary h-9 pl-10"
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-linear-text-secondary">SSH clone URL</label>
                  <div className="relative">
                    <SquareTerminal className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-linear-text-tertiary" />
                    <Input
                      value={repoDraft.sshUrl}
                      onChange={(e) => handleSshChange(e.target.value)}
                      placeholder="git@github.com:owner/repo.git"
                      className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary h-9 pl-10"
                    />
                  </div>
                </div>
              )}

              {hasRepoSelection(repoDraft) && (
                <div className="space-y-1.5 border-t border-linear-border pt-3">
                  <label className="text-xs font-medium text-linear-text-secondary">Default branch</label>
                  <Input
                    value={repoDraft.defaultBranch}
                    onChange={(e) => onRepoDraftChange({ defaultBranch: e.target.value })}
                    placeholder="main"
                    className="bg-linear-bg-tertiary border-linear-border text-linear-text h-8"
                  />
                  <div className="flex flex-wrap gap-1.5">
                    {suggestions.map((branch) => (
                      <button
                        key={branch}
                        type="button"
                        onClick={() => onRepoDraftChange({ defaultBranch: branch })}
                        className={`rounded-sm border px-2 py-0.5 text-xs transition-colors ${
                          repoDraft.defaultBranch === branch
                            ? "border-linear-accent/50 bg-linear-accent/10 text-linear-text"
                            : "border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
                        }`}
                      >
                        {branch}
                      </button>
                    ))}
                    {suggestions.length === 0 && (
                      <span className="text-xs text-linear-text-tertiary">No branches found. Type the branch name above.</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-9 px-4 text-sm font-medium transition-colors"
          >
            Back
          </button>
        )}
        <button
          type="button"
          onClick={onCreate}
          disabled={isCreating || !canCreate}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-9 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating...
            </>
          ) : (
            <>
              Continue
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>
    </div>
  )
}
