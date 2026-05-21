"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { motion, AnimatePresence, useReducedMotion } from "framer-motion"
import {
  ArrowRight,
  ArrowLeft,
  Building2,
  CalendarClock,
  Check,
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
  Mail,
  Rocket,
  Search,
  SquareTerminal,
  Star,
  Users2,
} from "lucide-react"
import { toast } from "sonner"
import { Input } from "@/components/ui/input"
import {
  createProject,
  createTask,
  createWorkspace,
  ApiError,
  createTeam,
  fetchGitHubRepos,
  importRepo,
  updateTeam,
  type GitHubRepo,
  type GitHubRepoFilter,
  type GitHubRepoSort,
  type Team,
} from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }
const STORAGE_KEY = "openlinear:onboarding:v3"
const REPO_PAGE_SIZE = 30

const STEP_LABELS = [
  "Workspace",
  "Connect repo",
  "Pick branch",
  "Set up team",
  "Create project",
] as const

const FILTER_OPTIONS: Array<{ value: GitHubRepoFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "owned", label: "Owned" },
  { value: "private", label: "Private" },
  { value: "public", label: "Public" },
  { value: "no_forks", label: "Forks excluded" },
]

const SORT_OPTIONS: Array<{ value: GitHubRepoSort; label: string }> = [
  { value: "pushed", label: "Recently pushed" },
  { value: "name", label: "Name A-Z" },
  { value: "stars", label: "Stars" },
]

interface OnboardingWizardProps {
  teams: Team[]
  onComplete: (result: { teamId: string; projectId: string; workspaceId: string }) => void
  onCancel?: () => void
}

type RepoSource = "github" | "link" | "ssh" | "demo"
type ProjectTab = "github" | "link" | "ssh"

interface RepoDraft {
  source: RepoSource
  selectedRepo: GitHubRepo | null
  repoUrl: string
  sshUrl: string
  defaultBranch: string
  projectName: string
}

interface StoredDraft {
  currentStep: number
  repoDraft: RepoDraft
  firstTaskTitle: string
}

const EMPTY_REPO_DRAFT: RepoDraft = {
  source: "github",
  selectedRepo: null,
  repoUrl: "",
  sshUrl: "",
  defaultBranch: "main",
  projectName: "",
}

function loadStoredDraft(): StoredDraft | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredDraft>
    return {
      currentStep: typeof parsed.currentStep === "number" ? parsed.currentStep : 0,
      repoDraft: { ...EMPTY_REPO_DRAFT, ...parsed.repoDraft },
      firstTaskTitle: typeof parsed.firstTaskTitle === "string" ? parsed.firstTaskTitle : "",
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

function getSelectedRepoLabel(draft: RepoDraft): string {
  if (draft.source === "github" && draft.selectedRepo) return draft.selectedRepo.full_name
  if (draft.source === "link") return draft.repoUrl.trim()
  if (draft.source === "ssh") return draft.sshUrl.trim()
  return "Demo project"
}

function hasRepoSelection(draft: RepoDraft): boolean {
  if (draft.source === "github") return Boolean(draft.selectedRepo)
  if (draft.source === "link") return draft.repoUrl.trim().length > 0
  if (draft.source === "ssh") return draft.sshUrl.trim().length > 0
  return true
}

function getDefaultBranchSuggestions(draft: RepoDraft): string[] {
  return Array.from(
    new Set(
      [
        draft.defaultBranch,
        draft.selectedRepo?.default_branch,
        "main",
        "develop",
        "master",
        "trunk",
      ]
        .map((branch) => branch?.trim())
        .filter(Boolean) as string[],
    ),
  )
}

function formatPushedAt(value?: string | null): string {
  if (!value) return "No pushes yet"
  const pushedAt = new Date(value)
  if (Number.isNaN(pushedAt.getTime())) return "Push date unknown"

  const seconds = Math.max(1, Math.floor((Date.now() - pushedAt.getTime()) / 1000))
  if (seconds < 60) return "Pushed just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Pushed ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Pushed ${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `Pushed ${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `Pushed ${months}mo ago`
  return `Pushed ${Math.floor(months / 12)}y ago`
}

function mergeRepos(existing: GitHubRepo[], next: GitHubRepo[]): GitHubRepo[] {
  const seen = new Set(existing.map((repo) => repo.id))
  const merged = [...existing]
  for (const repo of next) {
    if (!seen.has(repo.id)) {
      seen.add(repo.id)
      merged.push(repo)
    }
  }
  return merged
}

function WorkspaceStep({
  workspaceName,
  isCreating,
  onChange,
  onCreate,
  onSkipDemo,
  isSkipping,
}: {
  workspaceName: string
  isCreating: boolean
  onChange: (name: string) => void
  onCreate: () => void
  onSkipDemo: () => void
  isSkipping: boolean
}) {
  const reduceMotion = useReducedMotion()

  return (
    <div className="text-center space-y-6">
      <motion.div
        initial={reduceMotion ? false : { scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.1 }}
        className="w-20 h-20 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center"
      >
        <Building2 className="w-10 h-10 text-linear-accent" />
      </motion.div>

      <motion.div
        initial={reduceMotion ? false : { y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={reduceMotion ? { duration: 0 } : { ...SPRING, delay: 0.2 }}
        className="space-y-2"
      >
        <h2 className="text-2xl font-semibold text-linear-text">Create your workspace</h2>
        <p className="text-sm text-linear-text-secondary max-w-sm mx-auto leading-relaxed">
          A workspace is your team&apos;s home. All projects and issues live here.
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
          className="text-center"
        />
        <button
          type="button"
          onClick={onCreate}
          disabled={!workspaceName.trim() || isCreating}
          className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
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
        <button
          type="button"
          onClick={onSkipDemo}
          disabled={isSkipping}
          className="w-full border border-linear-border hover:bg-linear-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed text-linear-text-secondary rounded-sm h-9 px-6 text-xs font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isSkipping ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating demo...
            </>
          ) : (
            "Skip and explore demo"
          )}
        </button>
      </motion.div>
    </div>
  )
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
      type="button"
      onClick={() => onSelect(repo)}
      className={`w-full h-[90px] flex items-start gap-3 px-3 py-3 rounded-sm text-left transition-colors overflow-hidden ${
        isSelected
          ? "bg-linear-accent/10 border border-linear-accent/40"
          : "hover:bg-linear-bg-tertiary border border-transparent"
      }`}
    >
      {repo.owner?.avatar_url ? (
        <img
          src={repo.owner.avatar_url}
          alt=""
          className="w-8 h-8 rounded-sm border border-linear-border flex-shrink-0"
        />
      ) : (
        <div className="w-8 h-8 rounded-sm border border-linear-border bg-linear-bg-tertiary flex items-center justify-center text-xs text-linear-text-secondary flex-shrink-0">
          {owner[0]?.toUpperCase()}
        </div>
      )}

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-medium text-linear-text truncate">{repo.name}</span>
          {repo.private ? (
            <Lock className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
          ) : (
            <Globe2 className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />
          )}
          {repo.fork && <GitFork className="w-3.5 h-3.5 text-linear-text-tertiary flex-shrink-0" />}
        </div>
        <div className="text-xs text-linear-text-tertiary truncate">{owner} / {repo.name}</div>
        {repo.description && (
          <p className="text-xs text-linear-text-secondary line-clamp-1">{repo.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-linear-text-tertiary">
          <span className="inline-flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            {repo.default_branch || "main"}
          </span>
          <span className="inline-flex items-center gap-1">
            <CalendarClock className="w-3 h-3" />
            {formatPushedAt(repo.pushed_at)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Star className="w-3 h-3" />
            {repo.stargazers_count ?? 0}
          </span>
        </div>
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

function GitHubRepoTab({
  selectedRepo,
  onSelectRepo,
  onContinue,
}: {
  selectedRepo: GitHubRepo | null
  onSelectRepo: (repo: GitHubRepo | null) => void
  onContinue: () => void
}) {
  const { user, refreshUser } = useAuth()
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<GitHubRepoSort>("pushed")
  const [filter, setFilter] = useState<GitHubRepoFilter>("all")
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [totalCount, setTotalCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isLoadingRepos, setIsLoadingRepos] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const debouncedSearch = useDebouncedValue(search, 300)
  const scrollParentRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef(0)

  const hasGitHub = Boolean(user?.githubLinked ?? user?.githubId)

  const rowVirtualizer = useVirtualizer({
    count: repos.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 98,
    overscan: 8,
  })

  const loadRepos = useCallback(
    async (nextPage: number, replace: boolean) => {
      if (!hasGitHub) return
      const requestId = ++requestIdRef.current

      setError(null)
      if (replace) {
        setIsLoadingRepos(true)
      } else {
        setIsLoadingMore(true)
      }

      try {
        const result = await fetchGitHubRepos({
          page: nextPage,
          perPage: REPO_PAGE_SIZE,
          sort,
          filter,
          q: debouncedSearch,
        })
        if (requestId !== requestIdRef.current) return

        setRepos((current) => (replace ? result.repos : mergeRepos(current, result.repos)))
        setPage(nextPage)
        setHasMore(result.hasMore)
        setTotalCount(result.totalCount)
        if (replace) scrollParentRef.current?.scrollTo({ top: 0 })
      } catch (err) {
        if (requestId !== requestIdRef.current) return
        const message = err instanceof ApiError && err.code === "GITHUB_NOT_LINKED"
          ? "GitHub account not fully linked. Sign in with GitHub again to reconnect."
          : err instanceof Error && err.message
            ? err.message
            : "Failed to load repositories"
        setError(message)
      } finally {
        if (requestId !== requestIdRef.current) return
        setIsLoadingRepos(false)
        setIsLoadingMore(false)
      }
    },
    [debouncedSearch, filter, hasGitHub, sort],
  )

  useEffect(() => {
    if (!hasGitHub) return
    void loadRepos(1, true)
  }, [hasGitHub, loadRepos])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("connected") === "true") {
      window.history.replaceState({}, "", window.location.pathname)
      refreshUser()
      toast.success("GitHub connected successfully")
    }
  }, [refreshUser])

  const handleRepoSelect = useCallback(
    (repo: GitHubRepo) => {
      onSelectRepo(selectedRepo?.id === repo.id ? null : repo)
    },
    [onSelectRepo, selectedRepo?.id],
  )

  if (!hasGitHub) {
    return (
      <div className="flex flex-col items-center justify-center py-10 space-y-4">
        <div className="w-14 h-14 rounded-sm bg-linear-bg-tertiary flex items-center justify-center">
          <Github className="w-7 h-7 text-linear-text-secondary" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-linear-text">GitHub account not detected</p>
          <p className="text-xs text-linear-text-tertiary max-w-[280px]">
            Paste a repository URL or SSH clone URL instead, or sign in with GitHub again from the login screen.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-2 lg:grid-cols-[1fr_180px]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-linear-text-tertiary" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories..."
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9 pl-9 text-sm"
          />
        </div>
        <select
          value={sort}
          onChange={(event) => setSort(event.target.value as GitHubRepoSort)}
          className="h-9 rounded-sm border border-linear-border bg-linear-bg-tertiary px-3 text-sm text-linear-text focus:outline-none focus:border-linear-border-hover"
          aria-label="Sort repositories"
        >
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTER_OPTIONS.map((option) => {
          const isActive = filter === option.value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => setFilter(option.value)}
              className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${
                isActive
                  ? "border-linear-accent/50 bg-linear-accent/10 text-linear-text"
                  : "border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
              }`}
            >
              {option.label}
            </button>
          )
        })}
      </div>

      <div className="flex items-center justify-between text-xs text-linear-text-tertiary">
        <span>{totalCount > 0 ? `${totalCount}${hasMore ? "+" : ""} repositories` : "Repository results"}</span>
        {debouncedSearch && <span>Searching for "{debouncedSearch}"</span>}
      </div>

      <div
        ref={scrollParentRef}
        className="overflow-y-auto overscroll-contain rounded-sm border border-linear-border bg-linear-bg-secondary scrollbar-thin scrollbar-track-transparent scrollbar-thumb-linear-border"
        style={{ height: "min(60vh, 500px)", minHeight: 320 }}
      >
        {isLoadingRepos ? (
          <div className="flex flex-col items-center justify-center h-full space-y-3">
            <Loader2 className="w-5 h-5 animate-spin text-linear-text-secondary" />
            <p className="text-xs text-linear-text-tertiary">Loading repositories...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full space-y-3 px-4 text-center">
            <p className="text-sm font-medium text-linear-text">{error}</p>
            <button
              type="button"
              onClick={() => void loadRepos(1, true)}
              className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-8 px-3 text-xs font-medium transition-colors"
            >
              Try again
            </button>
          </div>
        ) : repos.length === 0 ? (
          <div className="flex items-center justify-center h-full px-4 text-center">
            <p className="text-xs text-linear-text-tertiary">
              {debouncedSearch ? "No matching repositories" : "No repositories found"}
            </p>
          </div>
        ) : (
          <div
            className="relative p-1"
            style={{ height: rowVirtualizer.getTotalSize() }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const repo = repos[virtualRow.index]
              if (!repo) return null

              return (
                <div
                  key={repo.id}
                  data-index={virtualRow.index}
                  className="absolute left-0 top-0 w-full px-1 pb-1"
                  style={{
                    transform: `translateY(${virtualRow.start}px)`,
                    height: virtualRow.size,
                  }}
                >
                  <RepoItem
                    repo={repo}
                    isSelected={selectedRepo?.id === repo.id}
                    onSelect={handleRepoSelect}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => void loadRepos(page + 1, false)}
          disabled={!hasMore || isLoadingRepos || isLoadingMore}
          className="border border-linear-border hover:bg-linear-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed text-linear-text rounded-sm h-9 px-3 text-xs font-medium transition-colors inline-flex items-center gap-2"
        >
          {isLoadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
          Load more
        </button>
      </div>

      <div className="sticky bottom-0 z-10 rounded-sm border border-linear-border bg-linear-bg-secondary p-3 shadow-sm">
        {selectedRepo ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary">Selected repo</div>
              <div className="text-sm font-medium text-linear-text truncate">{selectedRepo.full_name}</div>
              <div className="text-xs text-linear-text-tertiary truncate">
                Default branch: {selectedRepo.default_branch || "main"}
              </div>
            </div>
            <button
              type="button"
              onClick={onContinue}
              className="bg-linear-accent hover:bg-linear-accent-hover text-white rounded-sm h-9 px-4 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
            >
              Continue
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-linear-text-tertiary">Select a repository to continue.</p>
            <button
              type="button"
              disabled
              className="bg-linear-accent text-white rounded-sm h-9 px-4 text-sm font-medium opacity-50 cursor-not-allowed"
            >
              Continue
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function LinkTab({
  repoUrl,
  onUrlChange,
}: {
  repoUrl: string
  onUrlChange: (url: string) => void
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-1.5">
        <label htmlFor="onboarding-repo-url" className="text-xs font-medium text-linear-text-secondary">
          Public GitHub repository URL
        </label>
        <div className="relative">
          <Link className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-linear-text-tertiary" />
          <Input
            id="onboarding-repo-url"
            value={repoUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10 pl-10"
          />
        </div>
        <p className="text-xs text-linear-text-tertiary">
          Public repositories can be connected without GitHub OAuth.
        </p>
      </div>
    </div>
  )
}

function SshTab({
  sshUrl,
  onUrlChange,
}: {
  sshUrl: string
  onUrlChange: (url: string) => void
}) {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-1.5">
        <label htmlFor="onboarding-ssh-url" className="text-xs font-medium text-linear-text-secondary">
          SSH clone URL
        </label>
        <div className="relative">
          <SquareTerminal className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-linear-text-tertiary" />
          <Input
            id="onboarding-ssh-url"
            value={sshUrl}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="git@github.com:owner/repo.git"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10 pl-10"
          />
        </div>
        <p className="text-xs text-linear-text-tertiary">
          Use this when you prefer cloning through your local SSH key.
        </p>
      </div>
    </div>
  )
}

function RepoStep({
  draft,
  onDraftChange,
  onContinue,
}: {
  draft: RepoDraft
  onDraftChange: (patch: Partial<RepoDraft>) => void
  onContinue: () => void
}) {
  const initialTab = draft.source === "link" ? "link" : draft.source === "ssh" ? "ssh" : "github"
  const [activeTab, setActiveTab] = useState<ProjectTab>(initialTab)

  const tabs: { id: ProjectTab; label: string; icon: typeof Github }[] = [
    { id: "github", label: "GitHub Repos", icon: Github },
    { id: "link", label: "Public URL", icon: ExternalLink },
    { id: "ssh", label: "SSH Clone", icon: SquareTerminal },
  ]

  const handleRepoSelect = useCallback(
    (repo: GitHubRepo | null) => {
      onDraftChange({
        source: "github",
        selectedRepo: repo,
        repoUrl: repo ? getRepoUrl(repo) : "",
        sshUrl: repo?.ssh_url || "",
        defaultBranch: repo?.default_branch || draft.defaultBranch || "main",
        projectName: repo?.name || draft.projectName,
      })
    },
    [draft.defaultBranch, draft.projectName, onDraftChange],
  )

  const handleLinkChange = useCallback(
    (url: string) => {
      const name = deriveProjectNameFromUrl(url)
      onDraftChange({
        source: "link",
        selectedRepo: null,
        repoUrl: url,
        projectName: draft.projectName || name,
        defaultBranch: draft.defaultBranch || "main",
      })
    },
    [draft.defaultBranch, draft.projectName, onDraftChange],
  )

  const handleSshChange = useCallback(
    (url: string) => {
      const name = deriveProjectNameFromUrl(url)
      onDraftChange({
        source: "ssh",
        selectedRepo: null,
        sshUrl: url,
        repoUrl: "",
        projectName: draft.projectName || name,
        defaultBranch: draft.defaultBranch || "main",
      })
    },
    [draft.defaultBranch, draft.projectName, onDraftChange],
  )

  const canContinue = hasRepoSelection(draft)

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-4">
          <FolderKanban className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">Connect a Repository</h2>
        <p className="text-sm text-linear-text-secondary">
          Pick from GitHub, paste a public URL, or use an SSH clone URL.
        </p>
      </div>

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
                  onDraftChange({ source: "github", repoUrl: "", sshUrl: "" })
                } else if (tab.id === "link") {
                  onDraftChange({ source: "link", selectedRepo: null, sshUrl: "" })
                } else {
                  onDraftChange({ source: "ssh", selectedRepo: null, repoUrl: "" })
                }
              }}
              className={`flex items-center justify-center gap-1.5 h-8 rounded-sm text-xs font-medium transition-all ${
                isActive
                  ? "bg-linear-bg-secondary text-linear-text shadow-sm"
                  : "text-linear-text-tertiary hover:text-linear-text-secondary"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="truncate">{tab.label}</span>
            </button>
          )
        })}
      </div>

      {activeTab === "github" ? (
        <GitHubRepoTab selectedRepo={draft.selectedRepo} onSelectRepo={handleRepoSelect} onContinue={onContinue} />
      ) : activeTab === "link" ? (
        <>
          <LinkTab repoUrl={draft.repoUrl} onUrlChange={handleLinkChange} />
          <button
            type="button"
            onClick={onContinue}
            disabled={!canContinue}
            className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
          >
            Continue
            <ArrowRight className="w-4 h-4" />
          </button>
        </>
      ) : (
        <>
          <SshTab sshUrl={draft.sshUrl} onUrlChange={handleSshChange} />
          <button
            type="button"
            onClick={onContinue}
            disabled={!canContinue}
            className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
          >
            Continue
            <ArrowRight className="w-4 h-4" />
          </button>
        </>
      )}
    </div>
  )
}

function BranchStep({
  draft,
  onDraftChange,
  onBack,
  onContinue,
}: {
  draft: RepoDraft
  onDraftChange: (patch: Partial<RepoDraft>) => void
  onBack: () => void
  onContinue: () => void
}) {
  const suggestions = useMemo(() => getDefaultBranchSuggestions(draft), [draft])
  const canContinue = draft.defaultBranch.trim().length > 0

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-4">
          <GitBranch className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">Pick Default Branch</h2>
        <p className="text-sm text-linear-text-secondary">
          OpenLinear will use this branch for issue context and automation defaults.
        </p>
      </div>

      <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary px-4 py-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary">Repository</div>
        <div className="text-sm font-medium text-linear-text truncate">{getSelectedRepoLabel(draft)}</div>
      </div>

      <div className="space-y-2">
        <label htmlFor="onboarding-branch" className="text-xs font-medium text-linear-text-secondary">
          Default branch
        </label>
        <Input
          id="onboarding-branch"
          value={draft.defaultBranch}
          onChange={(e) => onDraftChange({ defaultBranch: e.target.value })}
          placeholder="main"
          className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
        />
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((branch) => (
            <button
              key={branch}
              type="button"
              onClick={() => onDraftChange({ defaultBranch: branch })}
              className={`rounded-sm border px-2.5 py-1 text-xs transition-colors ${
                draft.defaultBranch === branch
                  ? "border-linear-accent/50 bg-linear-accent/10 text-linear-text"
                  : "border-linear-border text-linear-text-secondary hover:bg-linear-bg-tertiary"
              }`}
            >
              {branch}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-10 px-4 text-sm font-medium transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={!canContinue}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

function TeamStep({
  team,
  onBack,
  onTeamReady,
}: {
  team: Team | null
  onBack: () => void
  onTeamReady: (team: Team) => void
}) {
  const { user } = useAuth()
  const [name, setName] = useState(() => {
    const base = user?.username ? `${user.username}'s Team` : "My Team"
    return base
  })
  const [key, setKey] = useState(() => deriveTeamKey(name))
  const [keyDirty, setKeyDirty] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    if (keyDirty) return
    setKey(deriveTeamKey(name))
  }, [name, keyDirty])

  const canCreate = name.trim().length > 0 && /^[A-Z][A-Z0-9]*$/.test(key.trim())

  const handleCreate = useCallback(async () => {
    if (!canCreate) return
    setIsCreating(true)
    try {
      const created = await createTeam({
        name: name.trim(),
        key: key.trim().toUpperCase(),
        private: true,
      })
      toast.success("Team created")
      onTeamReady(created)
    } catch {
      toast.error("Failed to create team. Please try again.")
    } finally {
      setIsCreating(false)
    }
  }, [canCreate, key, name, onTeamReady])

  if (team) {
    const [editName, setEditName] = useState(team.name)
    const [editKey, setEditKey] = useState(team.key)
    const [isEditing, setIsEditing] = useState(false)
    const [isSaving, setIsSaving] = useState(false)

    const canSave = editName.trim().length > 0 && /^[A-Z][A-Z0-9]*$/.test(editKey.trim())

    const handleSave = useCallback(async () => {
      if (!canSave) return
      setIsSaving(true)
      try {
        const updates: { name?: string; key?: string } = {}
        if (editName.trim() !== team.name) updates.name = editName.trim()
        if (editKey.trim().toUpperCase() !== team.key) updates.key = editKey.trim().toUpperCase()

        if (Object.keys(updates).length > 0) {
          const updated = await updateTeam(team.id, updates)
          toast.success("Team updated")
          onTeamReady(updated)
        }
        setIsEditing(false)
      } catch {
        toast.error("Failed to update team. Please try again.")
      } finally {
        setIsSaving(false)
      }
    }, [canSave, editKey, editName, onTeamReady, team])

    const handleCancel = useCallback(() => {
      setEditName(team.name)
      setEditKey(team.key)
      setIsEditing(false)
    }, [team])

    return (
      <div className="space-y-5">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-4">
            <Users2 className="w-6 h-6 text-linear-accent" />
          </div>
          <h2 className="text-xl font-semibold text-linear-text">Team Ready</h2>
          <p className="text-sm text-linear-text-secondary">
            Your project will be created inside{" "}
            <span className="text-linear-text">{team.name}</span>.
          </p>
        </div>

        <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary px-4 py-3 space-y-3">
          {isEditing ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label htmlFor="onboarding-team-name-edit" className="text-xs font-medium text-linear-text-secondary">
                  Team name
                </label>
                <Input
                  id="onboarding-team-name-edit"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="e.g., Platform"
                  className="bg-linear-bg-secondary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="onboarding-team-key-edit" className="text-xs font-medium text-linear-text-secondary">
                  Team key
                </label>
                <Input
                  id="onboarding-team-key-edit"
                  value={editKey}
                  onChange={(e) => setEditKey(e.target.value.toUpperCase())}
                  placeholder="e.g., PLAT"
                  className="bg-linear-bg-secondary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
                />
                <p className="text-xs text-linear-text-tertiary">Uppercase letters/numbers, starts with a letter.</p>
              </div>
            </div>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary">Team</div>
                <div className="text-sm font-medium text-linear-text truncate">{team.name}</div>
                <div className="text-xs text-linear-text-tertiary mt-0.5">Key: {team.key}</div>
              </div>
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                className="text-xs text-linear-accent hover:text-linear-accent-hover transition-colors"
              >
                Edit
              </button>
            </div>
          )}
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onBack}
            className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-10 px-4 text-sm font-medium transition-colors"
          >
            Back
          </button>
          {isEditing ? (
            <>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isSaving}
                className="border border-linear-border hover:bg-linear-bg-tertiary disabled:opacity-50 disabled:cursor-not-allowed text-linear-text rounded-sm h-10 px-4 text-sm font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving || !canSave}
                className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save"
                )}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onTeamReady(team)}
              className="flex-1 bg-linear-accent hover:bg-linear-accent-hover text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
            >
              Continue
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-4">
          <Users2 className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">Create Your Team</h2>
        <p className="text-sm text-linear-text-secondary">Set up a team to organize projects and issues.</p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="onboarding-team-name" className="text-xs font-medium text-linear-text-secondary">
            Team name
          </label>
          <Input
            id="onboarding-team-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Platform"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
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
            placeholder="e.g., PLAT"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
          />
          <p className="text-xs text-linear-text-tertiary">Uppercase letters/numbers, starts with a letter.</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-10 px-4 text-sm font-medium transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={handleCreate}
          disabled={isCreating || !canCreate}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating team...
            </>
          ) : (
            "Create Team"
          )}
        </button>
      </div>
    </div>
  )
}

function InviteStep({
  team,
  onBack,
  onContinue,
}: {
  team: Team | null
  onBack: () => void
  onContinue: () => void
}) {
  const [copied, setCopied] = useState(false)
  const inviteCode = team?.inviteCode || ""
  const inviteLink = typeof window !== "undefined" && inviteCode
    ? `${window.location.origin}/teams?invite=${inviteCode}`
    : inviteCode

  const handleCopy = useCallback(async () => {
    if (!inviteLink) return
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
      toast.success("Invite link copied")
    } catch {
      toast.error("Could not copy invite link")
    }
  }, [inviteLink])

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-4">
          <Mail className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">Invite Teammates</h2>
        <p className="text-sm text-linear-text-secondary">
          Optional for now. You can copy a link or draft email invites.
        </p>
      </div>

      <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary px-4 py-3 space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary">Invite code</div>
          <div className="text-sm font-medium text-linear-text truncate">{inviteCode || "Created after team setup"}</div>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!inviteLink}
          className="border border-linear-border hover:bg-linear-bg-secondary disabled:opacity-50 disabled:cursor-not-allowed text-linear-text rounded-sm h-9 px-3 text-xs font-medium transition-colors inline-flex items-center gap-2"
        >
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          Copy invite link
        </button>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-10 px-4 text-sm font-medium transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

function FirstTaskStep({
  draft,
  firstTaskTitle,
  isCreating,
  onDraftChange,
  onFirstTaskTitleChange,
  onBack,
  onCreate,
}: {
  draft: RepoDraft
  firstTaskTitle: string
  isCreating: boolean
  onDraftChange: (patch: Partial<RepoDraft>) => void
  onFirstTaskTitleChange: (value: string) => void
  onBack: () => void
  onCreate: () => void
}) {
  const canCreate = draft.projectName.trim().length > 0

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-sm bg-linear-accent/10 flex items-center justify-center mb-4">
          <Check className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">Create First Task</h2>
        <p className="text-sm text-linear-text-secondary">
          Name the project and optionally seed the first issue.
        </p>
      </div>

      <div className="rounded-sm border border-linear-border bg-linear-bg-tertiary px-4 py-3">
        <div className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary">Repository</div>
        <div className="text-sm font-medium text-linear-text truncate">{getSelectedRepoLabel(draft)}</div>
        <div className="text-xs text-linear-text-tertiary mt-0.5">Branch: {draft.defaultBranch || "main"}</div>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="onboarding-project-name" className="text-xs font-medium text-linear-text-secondary">
            Project name
          </label>
          <Input
            id="onboarding-project-name"
            value={draft.projectName}
            onChange={(e) => onDraftChange({ projectName: e.target.value })}
            placeholder="e.g., Web App"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="onboarding-first-task" className="text-xs font-medium text-linear-text-secondary">
            First task (optional)
          </label>
          <Input
            id="onboarding-first-task"
            value={firstTaskTitle}
            onChange={(e) => onFirstTaskTitleChange(e.target.value)}
            placeholder="e.g., Set up CI"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
          />
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-linear-border hover:bg-linear-bg-tertiary text-linear-text rounded-sm h-10 px-4 text-sm font-medium transition-colors"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={isCreating || !canCreate}
          className="flex-1 bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-sm h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isCreating ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Creating...
            </>
          ) : (
            "Create workspace"
          )}
        </button>
      </div>
    </div>
  )
}

function StepIndicator({ currentStep }: { currentStep: number }) {
  return (
    <div className="mb-10">
      <div className="flex items-center">
        {STEP_LABELS.map((label, index) => {
          const isActive = index === currentStep
          const isCompleted = index < currentStep

          return (
            <div key={label} className="contents">
              <div className="flex flex-col items-center shrink-0">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold transition-colors duration-300 ${
                    isCompleted || isActive
                      ? "bg-linear-accent text-white"
                      : "bg-linear-bg border-2 border-linear-border text-linear-text-tertiary"
                  }`}
                >
                  {isCompleted ? <Check className="w-5 h-5" /> : <span>{index + 1}</span>}
                </div>
                <span
                  className={`mt-3 text-xs text-center whitespace-nowrap ${
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
                <div className="flex-1 h-[2px] mx-3 mb-6 transition-colors duration-500">
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

export function OnboardingWizard({ teams, onComplete, onCancel }: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [repoDraft, setRepoDraft] = useState<RepoDraft>(EMPTY_REPO_DRAFT)
  const [firstTaskTitle, setFirstTaskTitle] = useState("")
  const [createdTeam, setCreatedTeam] = useState<Team | null>(null)
  const [workspaceName, setWorkspaceName] = useState("")
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null)
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false)
  const [isSkippingDemo, setIsSkippingDemo] = useState(false)
  const didLoadStoredDraftRef = useRef(false)
  const reduceMotion = useReducedMotion()
  const { user } = useAuth()

  const team = createdTeam || teams[0] || null

  useEffect(() => {
    const storedDraft = loadStoredDraft()
    if (storedDraft) {
      setCurrentStep(storedDraft.currentStep)
      setRepoDraft(storedDraft.repoDraft)
      setFirstTaskTitle(storedDraft.firstTaskTitle)
    }
    didLoadStoredDraftRef.current = true
  }, [])

  useEffect(() => {
    if (!didLoadStoredDraftRef.current) return
    saveStoredDraft({ currentStep, repoDraft, firstTaskTitle })
  }, [currentStep, firstTaskTitle, repoDraft])

  useEffect(() => {
    if (currentStep > 1 && !createdWorkspaceId) {
      setCurrentStep(0)
      return
    }
    if (currentStep > 2 && !hasRepoSelection(repoDraft)) {
      setCurrentStep(1)
      return
    }
    if (currentStep > 3 && !team) {
      setCurrentStep(3)
    }
  }, [currentStep, repoDraft, team, createdWorkspaceId])

  const updateRepoDraft = useCallback((patch: Partial<RepoDraft>) => {
    setRepoDraft((current) => ({ ...current, ...patch }))
  }, [])

  const goToStep = useCallback((step: number) => {
    setCurrentStep(Math.max(0, Math.min(step, STEP_LABELS.length - 1)))
  }, [])

  const ensureTeam = useCallback(async () => {
    if (team) return team

    const name = user?.username ? `${user.username}'s Team` : "Demo Team"
    const keyBase = deriveTeamKey(name).slice(0, 6)
    const created = await createTeam({
      name,
      key: `${keyBase}${Date.now().toString().slice(-3)}`.slice(0, 10),
      private: true,
    })
    setCreatedTeam(created)
    return created
  }, [team, user?.username])

  const handleCreateWorkspaceStep = useCallback(async () => {
    if (!workspaceName.trim()) return
    setIsCreatingWorkspace(true)
    try {
      const ws = await createWorkspace({ name: workspaceName.trim() })
      setCreatedWorkspaceId(ws.id)
      goToStep(1)
    } catch {
      toast.error("Failed to create workspace. Please try again.")
    } finally {
      setIsCreatingWorkspace(false)
    }
  }, [workspaceName, goToStep])

  const handleSkipDemo = useCallback(async () => {
    setIsSkippingDemo(true)
    try {
      let wsId = createdWorkspaceId
      if (!wsId) {
        const ws = await createWorkspace({ name: user?.username ? `${user.username}'s Workspace` : "My Workspace" })
        wsId = ws.id
        setCreatedWorkspaceId(wsId)
      }
      const resolvedTeam = await ensureTeam()
      const project = await createProject({
        name: "Demo Project",
        teamIds: [resolvedTeam.id],
        workspaceId: wsId,
      })
      clearStoredDraft()
      onComplete({ teamId: resolvedTeam.id, projectId: project.id, workspaceId: wsId })
    } catch {
      toast.error("Failed to create demo project. Please try again.")
    } finally {
      setIsSkippingDemo(false)
    }
  }, [createdWorkspaceId, ensureTeam, onComplete, user?.username])

  const handleCreateProject = useCallback(async () => {
    if (!repoDraft.projectName.trim() || !createdWorkspaceId) return
    setIsCreatingWorkspace(true)

    try {
      const resolvedTeam = await ensureTeam()
      let repositoryId: string | undefined
      let repoUrl: string | undefined

      if (repoDraft.source === "github" && repoDraft.selectedRepo) {
        const imported = await importRepo({
          ...repoDraft.selectedRepo,
          default_branch: repoDraft.defaultBranch.trim(),
        })
        repositoryId = imported.id
        repoUrl = getRepoUrl(repoDraft.selectedRepo)
      } else if (repoDraft.source === "link") {
        repoUrl = repoDraft.repoUrl.trim()
      } else if (repoDraft.source === "ssh") {
        repoUrl = repoDraft.sshUrl.trim()
      }

      const project = await createProject({
        name: repoDraft.projectName.trim(),
        teamIds: [resolvedTeam.id],
        repoUrl,
        repositoryId,
        defaultBranch: repoDraft.defaultBranch.trim() || "main",
        workspaceId: createdWorkspaceId,
      })

      if (firstTaskTitle.trim()) {
        await createTask({
          title: firstTaskTitle.trim(),
          projectId: project.id,
          priority: "medium",
        })
      }

      clearStoredDraft()
      onComplete({ teamId: resolvedTeam.id, projectId: project.id, workspaceId: createdWorkspaceId })
    } catch {
      toast.error("Failed to create project. Please try again.")
    } finally {
      setIsCreatingWorkspace(false)
    }
  }, [createdWorkspaceId, ensureTeam, firstTaskTitle, onComplete, repoDraft])

  const handleRepoContinue = useCallback(() => {
    if (!hasRepoSelection(repoDraft)) return
    const defaultBranch = repoDraft.defaultBranch || repoDraft.selectedRepo?.default_branch || "main"
    const projectName =
      repoDraft.projectName ||
      repoDraft.selectedRepo?.name ||
      deriveProjectNameFromUrl(repoDraft.source === "ssh" ? repoDraft.sshUrl : repoDraft.repoUrl)

    updateRepoDraft({ defaultBranch, projectName })
    goToStep(2)
  }, [goToStep, repoDraft, updateRepoDraft])

  const handleTeamReady = useCallback(
    (nextTeam: Team) => {
      setCreatedTeam(nextTeam)
      goToStep(4)
    },
    [goToStep],
  )

  const steps = [
    <WorkspaceStep
      key="workspace"
      workspaceName={workspaceName}
      isCreating={isCreatingWorkspace}
      onChange={setWorkspaceName}
      onCreate={handleCreateWorkspaceStep}
      onSkipDemo={handleSkipDemo}
      isSkipping={isSkippingDemo}
    />,
    <RepoStep key="repo" draft={repoDraft} onDraftChange={updateRepoDraft} onContinue={handleRepoContinue} />,
    <BranchStep
      key="branch"
      draft={repoDraft}
      onDraftChange={updateRepoDraft}
      onBack={() => goToStep(1)}
      onContinue={() => goToStep(3)}
    />,
    <TeamStep key="team" team={team} onBack={() => goToStep(2)} onTeamReady={handleTeamReady} />,
    <FirstTaskStep
      key="project"
      draft={repoDraft}
      firstTaskTitle={firstTaskTitle}
      isCreating={isCreatingWorkspace}
      onDraftChange={updateRepoDraft}
      onFirstTaskTitleChange={setFirstTaskTitle}
      onBack={() => goToStep(3)}
      onCreate={handleCreateProject}
    />,
  ]
  const stepBody = steps[currentStep] ?? steps[0]
  const shouldAnimateStep = currentStep === 0 || currentStep === 3
  const cardClassName = "bg-linear-bg-secondary border border-linear-border rounded-sm p-6"

  return (
    <div className="w-full max-w-3xl mx-auto">
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

      {shouldAnimateStep ? (
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
      ) : (
        <div className={cardClassName}>{stepBody}</div>
      )}
    </div>
  )
}
