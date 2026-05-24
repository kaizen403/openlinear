import type { GitHubRepo } from "@/lib/api"

export const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }
export const STORAGE_KEY = "openlinear:onboarding:v4"
export const REPO_SEARCH_LIMIT = 8
export const STEP_LABELS = ["Workspace", "Project", "Team"] as const

export type ProjectTab = "github" | "link" | "ssh"

export interface RepoDraft {
  source: ProjectTab
  selectedRepo: GitHubRepo | null
  repoUrl: string
  sshUrl: string
  defaultBranch: string
}

export interface StoredDraft {
  currentStep: number
  workspaceName: string
  projectName: string
  repoDraft: RepoDraft
  teamName: string
  createdWorkspaceId?: string | null
  createdProjectId?: string | null
}

export const EMPTY_REPO_DRAFT: RepoDraft = {
  source: "github",
  selectedRepo: null,
  repoUrl: "",
  sshUrl: "",
  defaultBranch: "main",
}

export function loadStoredDraft(): StoredDraft | null {
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

export function saveStoredDraft(draft: StoredDraft) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(draft))
}

export function clearStoredDraft() {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(STORAGE_KEY)
}

export function deriveTeamKey(name: string): string {
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

export function deriveDefaultTeamName(projectName: string | null | undefined): string {
  const base = (projectName || "Project")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 45)
    .trim() || "Project"

  if (/\bteam$/i.test(base)) return base.slice(0, 50)
  return `${base} Team`.slice(0, 50).trim()
}

export function deriveProjectNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, "")
  const match = trimmed.match(/(?:github\.com[:/])?[^/:\s]+\/([^/:\s]+)$/)
  return match?.[1] || ""
}

export function getRepoUrl(repo: GitHubRepo): string {
  return repo.html_url || `https://github.com/${repo.full_name}`
}

export function getOwnerLogin(repo: GitHubRepo): string {
  return repo.owner?.login || repo.full_name.split("/")[0] || "github"
}

export function hasRepoSelection(draft: RepoDraft): boolean {
  if (draft.source === "github") return Boolean(draft.selectedRepo)
  if (draft.source === "link") return draft.repoUrl.trim().length > 0
  if (draft.source === "ssh") return draft.sshUrl.trim().length > 0
  return false
}

export function getRepoSummary(draft: RepoDraft): string | null {
  if (draft.source === "github" && draft.selectedRepo) return draft.selectedRepo.full_name
  if (draft.source === "link" && draft.repoUrl.trim()) return draft.repoUrl.trim().replace(/^https?:\/\/github\.com\//, "")
  if (draft.source === "ssh" && draft.sshUrl.trim()) return draft.sshUrl.trim().replace(/^git@github\.com:/, "")
  return null
}

export function getDefaultBranchSuggestions(draft: RepoDraft): string[] {
  return Array.from(
    new Set(
      [draft.selectedRepo?.default_branch, draft.defaultBranch]
        .map((branch) => branch?.trim())
        .filter(Boolean) as string[],
    ),
  )
}
