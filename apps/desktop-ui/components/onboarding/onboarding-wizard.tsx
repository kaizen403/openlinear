"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { motion, AnimatePresence, useReducedMotion } from "framer-motion"
import {
  ArrowRight,
  ArrowLeft,
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderKanban,
  GitBranch,
  GitFork,
  Github,
  Globe2,
  Link,
  Loader2,
  Lock,
  Rocket,
  Search,
  SquareTerminal,
  Users2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import {
  createProject,
  createWorkspace,
  ApiError,
  createTeam,
  fetchGitHubRepos,
  importRepo,
  type GitHubRepo,
  type Team,
} from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }
const STORAGE_KEY = "openlinear:onboarding:v4"
const REPO_SEARCH_LIMIT = 8

const STEP_LABELS = ["Workspace", "Project", "Team"] as const

interface OnboardingWizardProps {
  teams: Team[]
  initialWorkspaceId?: string | null
  onComplete: (result: { teamId: string; projectId: string; workspaceId: string }) => void
  onCancel?: () => void
}

type ProjectTab = "github" | "link" | "ssh"

interface RepoDraft {
  source: ProjectTab
  selectedRepo: GitHubRepo | null
  repoUrl: string
  sshUrl: string
  defaultBranch: string
}

interface StoredDraft {
  currentStep: number
  workspaceName: string
  projectName: string
  repoDraft: RepoDraft
  teamName: string
  createdWorkspaceId?: string | null
  createdProjectId?: string | null
}

const EMPTY_REPO_DRAFT: RepoDraft = {
  source: "github",
  selectedRepo: null,
  repoUrl: "",
  sshUrl: "",
  defaultBranch: "main",
}

function loadStoredDraft(): StoredDraft | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredDraft>
    return {
      currentStep: typeof parsed.currentStep === "number" ? parsed.currentStep : 0,
      workspaceName: typeof parsed.workspaceName === "string" ? parsed.workspaceName : "",
      projectName: typeof parsed.projectName === "string" ? parsed.projectName : "",
      repoDraft: { ...EMPTY_REPO_DRAFT, ...parsed.repoDraft },
      teamName: typeof parsed.teamName === "string" ? parsed.teamName : "",
      createdWorkspaceId: typeof parsed.createdWorkspaceId === "string" ? parsed.createdWorkspaceId : null,
      createdProjectId: typeof parsed.createdProjectId === "string" ? parsed.createdProjectId : null,
    }
  } catch {
    return null
  }
}

function saveStoredDraft(draft: StoredDraft) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
}

function clearStoredDraft() {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(STORAGE_KEY)
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs)
    return () => window.clearTimeout(timeout)
  }, [delayMs, value])

  return debouncedValue
}

function deriveTeamKey(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean)

  const initials = parts.map((p) => p[0] || "").join("")
  let key = (initials || parts.join("") || "TEAM").toUpperCase()
  key = key.replace(/[^A-Z0-9]/g, "")
  if (!/^[A-Z]/.test(key)) key = `T${key}`
  return key.slice(0, 10) || "TEAM"
}

function deriveProjectNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, "")
  const match = trimmed.match(/(?:github\.com[:/])?[^/:\s]+\/([^/:\s]+)$/)
  return match?.[1] || ""
}

function getRepoUrl(repo: GitHubRepo): string {
  return repo.html_url || `https://github.com/${repo.full_name}`
}

function getOwnerLogin(repo: GitHubRepo): string {
  return repo.owner?.login || repo.full_name.split("/")[0] || "github"
}

function hasRepoSelection(draft: RepoDraft): boolean {
  if (draft.source === "github") return Boolean(draft.selectedRepo)
  if (draft.source === "link") return draft.repoUrl.trim().length > 0
  if (draft.source === "ssh") return draft.sshUrl.trim().length > 0
  return false
}

function getRepoSummary(draft: RepoDraft): string | null {
  if (draft.source === "github" && draft.selectedRepo) return draft.selectedRepo.full_name
  if (draft.source === "link" && draft.repoUrl.trim()) return draft.repoUrl.trim().replace(/^https?:\/\/github\.com\//, "")
  if (draft.source === "ssh" && draft.sshUrl.trim()) return draft.sshUrl.trim().replace(/^git@github\.com:/, "")
  return null
}

function getDefaultBranchSuggestions(draft: RepoDraft): string[] {
  return Array.from(
    new Set(
      [
        draft.selectedRepo?.default_branch,
        draft.defaultBranch,
      ]
        .map((branch) => branch?.trim())
        .filter(Boolean) as string[],
    ),
  )
}

// ─── Step 1: Workspace ──────────────────────────────────────────────────────

function WorkspaceStep({
  workspaceName,
  isCreating,
  onChange,
  onCreate,
}: {
  workspaceName: string
  isCreating: boolean
  onChange: (name: string) => void
  onCreate: () => void
}) {
  const reduceMotion = useReducedMotion()

  return (
    <div className="text-center space-y-5">
      <motion.div
        initial={reduceMotion ? false : { scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.1 }}
        className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center"
      >
        <Building2 className="w-6 h-6 text-linear-accent" />
      </motion.div>

      <motion.div
        initial={reduceMotion ? false : { y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.2 }}
        className="space-y-2"
      >
        <h2 className="text-xl font-semibold text-linear-text">Create your workspace</h2>
        <p className="text-sm text-linear-text-secondary max-w-sm mx-auto leading-relaxed">
          A workspace is your team&apos;s home. All projects and members live here.
        </p>
      </motion.div>

      <motion.div
        initial={reduceMotion ? false : { y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.3 }}
        className="max-w-xs mx-auto space-y-4"
      >
        <Input
          placeholder="e.g. Acme Inc"
          value={workspaceName}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && workspaceName.trim()) onCreate()
          }}
          className="text-center h-9"
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={!workspaceName.trim() || isCreating}
          className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-9 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
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
      </motion.div>
    </div>
  )
}

// ─── Repo Picker (inline in Project step) ───────────────────────────────────

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

  const loadRepos = useCallback(
    async () => {
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
    },
    [hasGitHub, repoQuery],
  )

  useEffect(() => {
    return () => {
      requestIdRef.current += 1
      repoRequestControllerRef.current?.abort()
      repoRequestControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    loadRepos()
  }, [loadRepos])

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
        <>
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
        </>
      )}
    </div>
  )
})

// ─── Step 2: Project (with optional repo) ───────────────────────────────────

function ProjectStep({
  projectName,
  repoDraft,
  isCreating,
  onProjectNameChange,
  onRepoDraftChange,
  onBack,
  onCreate,
}: {
  projectName: string
  repoDraft: RepoDraft
  isCreating: boolean
  onProjectNameChange: (name: string) => void
  onRepoDraftChange: (patch: Partial<RepoDraft>) => void
  onBack: () => void
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
        <h2 className="text-lg font-semibold text-linear-text">Create a project</h2>
        <p className="text-xs text-linear-text-secondary">
          Projects group your tasks and connect to a code repository.
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
          className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9"
        />
      </div>

      {/* Collapsible repo section */}
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
          <span className="text-sm text-linear-text-secondary">
            Connect a repository
          </span>
          <span className="ml-auto max-w-[220px] truncate text-xs text-linear-text-tertiary">
            {repoSummary ?? "Optional"}
          </span>
        </button>

        {showRepo && (
          <div className="border-t border-linear-border px-3 py-3 space-y-3">
            {/* Tabs */}
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

            {/* Tab content */}
            {activeTab === "github" ? (
              <GitHubRepoList
                selectedRepo={repoDraft.selectedRepo}
                onSelectRepo={handleRepoSelect}
              />
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

            {/* Branch picker — show if repo is selected */}
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

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-9 px-4 text-sm font-medium transition-colors"
        >
          Back
        </button>
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

// ─── Step 3: Team ───────────────────────────────────────────────────────────

function TeamStep({
  teamName,
  isCreating,
  onNameChange,
  onBack,
  onCreate,
}: {
  teamName: string
  isCreating: boolean
  onNameChange: (name: string) => void
  onBack: () => void
  onCreate: () => void
}) {
  const [key, setKey] = useState(() => deriveTeamKey(teamName || "Team"))
  const [keyDirty, setKeyDirty] = useState(false)

  useEffect(() => {
    if (keyDirty) return
    if (teamName.trim()) {
      setKey(deriveTeamKey(teamName))
    }
  }, [teamName, keyDirty])

  const canCreate = teamName.trim().length > 0 && /^[A-Z][A-Z0-9]*$/.test(key.trim())

  return (
    <div className="space-y-4">
      <div className="text-center space-y-1.5">
        <div className="w-10 h-10 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-2">
          <Users2 className="w-5 h-5 text-linear-accent" />
        </div>
        <h2 className="text-lg font-semibold text-linear-text">Create a team</h2>
        <p className="text-xs text-linear-text-secondary">
          Teams organize work inside a project. You can add more later.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="onboarding-team-name" className="text-xs font-medium text-linear-text-secondary">
            Team name
          </label>
          <Input
            id="onboarding-team-name"
            value={teamName}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="e.g., Frontend"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="onboarding-team-key" className="text-xs font-medium text-linear-text-secondary">
            Team key
          </label>
          <Input
            id="onboarding-team-key"
            value={key}
            onChange={(e) => {
              setKeyDirty(true)
              setKey(e.target.value.toUpperCase())
            }}
            placeholder="e.g., FE"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9"
          />
          <p className="text-xs text-linear-text-tertiary">Uppercase letters and numbers, starts with a letter.</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-9 px-4 text-sm font-medium transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={isCreating || !canCreate}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-9 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Finishing setup...
            </>
          ) : (
            <>
              <Rocket className="w-4 h-4" />
              Finish setup
            </>
          )}
        </button>
      </div>
    </div>
  )
}

// ─── Step Indicator ─────────────────────────────────────────────────────────

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="mb-5">
      <div className="flex items-center">
        {STEP_LABELS.map((label, index) => {
          const isActive = index === currentStep
          const isCompleted = index < currentStep

          return (
            <div key={label} className="contents">
              <div className="flex flex-col items-center shrink-0">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold transition-colors duration-300 ${
                    isCompleted || isActive
                      ? "bg-linear-accent text-white"
                      : "bg-linear-bg border-2 border-linear-border text-linear-text-tertiary"
                  }`}
                >
                  {isCompleted ? <Check className="w-3.5 h-3.5" /> : <span>{index + 1}</span>}
                </div>
                <span
                  className={`mt-1.5 text-xs text-center whitespace-nowrap ${
                    isActive
                      ? "text-linear-text font-medium"
                      : isCompleted
                        ? "text-linear-text-secondary"
                        : "text-linear-text-tertiary"
                  }`}
                >
                  {label}
                </span>
              </div>
              {index < STEP_LABELS.length - 1 && (
                <div className="flex-1 h-[2px] mx-3 mb-4 transition-colors duration-500">
                  <div
                    className={`h-full rounded-full transition-colors duration-500 ${
                      index < currentStep ? "bg-linear-accent" : "bg-linear-border"
                    }`}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function OnboardingWizard({ teams, initialWorkspaceId = null, onComplete, onCancel }: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [workspaceName, setWorkspaceName] = useState("")
  const [projectName, setProjectName] = useState("")
  const [teamName, setTeamName] = useState("")
  const [repoDraft, setRepoDraft] = useState<RepoDraft>(EMPTY_REPO_DRAFT)
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(initialWorkspaceId)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [isWorking, setIsWorking] = useState(false)
  const didLoadStoredDraftRef = useRef(false)
  const reduceMotion = useReducedMotion()
  const { user } = useAuth()

  // Restore draft
  useEffect(() => {
    if (didLoadStoredDraftRef.current) return
    const storedDraft = loadStoredDraft()
    if (storedDraft) {
      const restoredWorkspaceId = initialWorkspaceId ?? storedDraft.createdWorkspaceId ?? null
      let restoredStep = restoredWorkspaceId ? storedDraft.currentStep : 0
      if (restoredWorkspaceId && restoredStep === 0) restoredStep = 1
      if (restoredStep === 2 && !storedDraft.createdProjectId) restoredStep = 1
      setCurrentStep(Math.min(Math.max(restoredStep, 0), 2))
      setWorkspaceName(storedDraft.workspaceName)
      setProjectName(storedDraft.projectName)
      setRepoDraft(storedDraft.repoDraft)
      setTeamName(storedDraft.teamName)
      setCreatedWorkspaceId(restoredWorkspaceId)
      setCreatedProjectId(storedDraft.createdProjectId ?? null)
    } else if (initialWorkspaceId) {
      setCreatedWorkspaceId(initialWorkspaceId)
      setCurrentStep(1)
    }
    didLoadStoredDraftRef.current = true
  }, [initialWorkspaceId])

  useEffect(() => {
    if (!initialWorkspaceId) return
    setCreatedWorkspaceId((current) => current ?? initialWorkspaceId)
  }, [initialWorkspaceId])

  // Save draft
  useEffect(() => {
    if (!didLoadStoredDraftRef.current) return
    saveStoredDraft({ currentStep, workspaceName, projectName, repoDraft, teamName, createdWorkspaceId, createdProjectId })
  }, [currentStep, workspaceName, projectName, repoDraft, teamName, createdWorkspaceId, createdProjectId])

  const updateRepoDraft = useCallback((patch: Partial<RepoDraft>) => {
    setRepoDraft((current) => ({ ...current, ...patch }))
  }, [])

  // Step 0: Create workspace
  const handleCreateWorkspace = useCallback(async () => {
    if (!workspaceName.trim()) return
    setIsWorking(true)
    try {
      const ws = await createWorkspace({ name: workspaceName.trim() })
      setCreatedWorkspaceId(ws.id)
      setCurrentStep(1)
    } catch {
      toast.error("Failed to create workspace. Please try again.")
    } finally {
      setIsWorking(false)
    }
  }, [workspaceName])

  // Step 1: Create project
  const handleCreateProject = useCallback(async () => {
    const workspaceIdForProject = createdWorkspaceId ?? initialWorkspaceId
    if (!projectName.trim() || !workspaceIdForProject) return
    setIsWorking(true)

    try {
      let repositoryId: string | undefined
      let repoUrl: string | undefined

      if (repoDraft.source === "github" && repoDraft.selectedRepo) {
        const imported = await importRepo({
          ...repoDraft.selectedRepo,
          default_branch: repoDraft.defaultBranch.trim() || "main",
        })
        repositoryId = imported.id
        repoUrl = getRepoUrl(repoDraft.selectedRepo)
      } else if (repoDraft.source === "link" && repoDraft.repoUrl.trim()) {
        repoUrl = repoDraft.repoUrl.trim()
      } else if (repoDraft.source === "ssh" && repoDraft.sshUrl.trim()) {
        repoUrl = repoDraft.sshUrl.trim()
      }

      const project = await createProject({
        name: projectName.trim(),
        workspaceId: workspaceIdForProject,
        repoUrl,
        repositoryId,
        defaultBranch: repoDraft.defaultBranch.trim() || "main",
      })

      setCreatedWorkspaceId(workspaceIdForProject)
      setCreatedProjectId(project.id)
      setCurrentStep(2)
    } catch {
      toast.error("Failed to create project. Please try again.")
    } finally {
      setIsWorking(false)
    }
  }, [projectName, createdWorkspaceId, initialWorkspaceId, repoDraft])

  // Step 2: Create team and finish
  const handleCreateTeam = useCallback(async () => {
    const workspaceIdForCompletion = createdWorkspaceId ?? initialWorkspaceId
    if (!teamName.trim() || !workspaceIdForCompletion || !createdProjectId) return
    setIsWorking(true)

    try {
      const key = deriveTeamKey(teamName)
      const created = await createTeam({
        name: teamName.trim(),
        key,
        projectId: createdProjectId,
        private: false,
      })

      clearStoredDraft()
      onComplete({
        teamId: created.id,
        projectId: createdProjectId,
        workspaceId: workspaceIdForCompletion,
      })
    } catch {
      toast.error("Failed to create team. Please try again.")
    } finally {
      setIsWorking(false)
    }
  }, [teamName, createdWorkspaceId, initialWorkspaceId, createdProjectId, onComplete])

  const stepBody = (() => {
    switch (currentStep) {
      case 0:
        return (
          <WorkspaceStep
            workspaceName={workspaceName}
            isCreating={isWorking}
            onChange={setWorkspaceName}
            onCreate={handleCreateWorkspace}
          />
        )
      case 1:
        return (
          <ProjectStep
            projectName={projectName}
            repoDraft={repoDraft}
            isCreating={isWorking}
            onProjectNameChange={setProjectName}
            onRepoDraftChange={updateRepoDraft}
            onBack={() => setCurrentStep(0)}
            onCreate={handleCreateProject}
          />
        )
      case 2:
        return (
          <TeamStep
            teamName={teamName}
            isCreating={isWorking}
            onNameChange={setTeamName}
            onBack={() => setCurrentStep(1)}
            onCreate={handleCreateTeam}
          />
        )
      default:
        return null
    }
  })()

  const cardClassName = "bg-linear-bg-secondary border border-linear-border rounded-sm p-4 sm:p-5"

  return (
    <div className="w-full max-w-[660px] mx-auto py-2">
      <StepIndicator currentStep={currentStep} />
      {onCancel && (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 text-xs text-linear-text-secondary hover:text-linear-text transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to projects
          </button>
        </div>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={currentStep}
          initial={reduceMotion ? false : { opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -20 }}
          transition={reduceMotion ? { duration: 0 } : SPRING}
          className={cardClassName}
        >
          {stepBody}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
