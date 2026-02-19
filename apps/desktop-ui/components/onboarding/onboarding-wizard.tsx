"use client"

import { useState, useEffect, useCallback, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Rocket,
  FolderKanban,
  Users2,
  Github,
  ArrowRight,
  Loader2,
  Search,
  Lock,
  Link,
  ExternalLink,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import {
  createTeam,
  createProject,
  fetchGitHubRepos,
  getGitHubConnectUrl,
  type Team,
  type GitHubRepo,
} from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

interface OnboardingWizardProps {
  teams: Team[]
  onComplete: (result: { teamId: string; projectId: string }) => void
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="text-center space-y-6">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ ...SPRING, delay: 0.1 }}
        className="w-20 h-20 mx-auto rounded-2xl bg-linear-accent/10 flex items-center justify-center"
      >
        <Rocket className="w-10 h-10 text-linear-accent" />
      </motion.div>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING, delay: 0.2 }}
        className="space-y-2"
      >
        <h2 className="text-2xl font-semibold text-linear-text">
            Welcome to OpenLinear
        </h2>
        <p className="text-sm text-linear-text-secondary max-w-xs mx-auto leading-relaxed">
          AI-powered project management that writes the code. Manage tasks visually, then let AI execute them.
        </p>
      </motion.div>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING, delay: 0.3 }}
      >
        <button
          type="button"
          onClick={onNext}
          className="bg-linear-accent hover:bg-linear-accent-hover text-white rounded-md h-10 px-6 text-sm font-medium transition-colors inline-flex items-center gap-2"
        >
          Get Started
          <ArrowRight className="w-4 h-4" />
        </button>
      </motion.div>
    </div>
  )
}

type ProjectTab = "github" | "link"

function RepoItem({
  repo,
  isSelected,
  onSelect,
}: {
  repo: GitHubRepo
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
        isSelected
          ? "bg-linear-accent/10 border border-linear-accent/40"
          : "hover:bg-linear-bg-tertiary border border-transparent"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-linear-text truncate">
            {repo.name}
          </span>
          {repo.private && (
            <Lock className="w-3 h-3 text-linear-text-tertiary flex-shrink-0" />
          )}
        </div>
        {repo.description && (
          <p className="text-xs text-linear-text-tertiary truncate mt-0.5">
            {repo.description}
          </p>
        )}
      </div>
      <div
        className={`w-4 h-4 rounded-full border-2 flex-shrink-0 flex items-center justify-center transition-colors ${
          isSelected
            ? "border-linear-accent bg-linear-accent"
            : "border-linear-border"
        }`}
      >
        {isSelected && (
          <div className="w-1.5 h-1.5 rounded-full bg-white" />
        )}
      </div>
    </button>
  )
}

function GitHubRepoTab({
  onSelectRepo,
  selectedRepo,
}: {
  onSelectRepo: (repo: GitHubRepo | null) => void
  selectedRepo: GitHubRepo | null
}) {
  const { user, refreshUser } = useAuth()
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [isLoadingRepos, setIsLoadingRepos] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [search, setSearch] = useState("")

  const hasGitHub = !!user?.githubId

  useEffect(() => {
    if (!hasGitHub) return

    setIsLoadingRepos(true)
    fetchGitHubRepos()
      .then(setRepos)
      .catch(() => toast.error("Failed to load repositories"))
      .finally(() => setIsLoadingRepos(false))
  }, [hasGitHub])

  const filteredRepos = useMemo(() => {
    if (!search.trim()) return repos
    const q = search.toLowerCase()
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.full_name.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q)
    )
  }, [repos, search])

  const handleConnect = useCallback(async () => {
    setIsConnecting(true)
    try {
      const url = await getGitHubConnectUrl()
      window.location.href = url
    } catch {
      toast.error("Failed to start GitHub connection")
      setIsConnecting(false)
    }
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get("connected") === "true") {
      window.history.replaceState({}, "", window.location.pathname)
      refreshUser()
      toast.success("GitHub connected successfully!")
    }
  }, [refreshUser])

  if (!hasGitHub) {
    return (
      <div className="flex flex-col items-center justify-center py-8 space-y-4">
        <div className="w-14 h-14 rounded-xl bg-linear-bg-tertiary flex items-center justify-center">
          <Github className="w-7 h-7 text-linear-text-secondary" />
        </div>
        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-linear-text">
            Connect your GitHub account
          </p>
          <p className="text-xs text-linear-text-tertiary max-w-[240px]">
            Link GitHub to import your repositories and start managing projects.
          </p>
        </div>
        <button
          type="button"
          onClick={handleConnect}
          disabled={isConnecting}
          className="bg-[#24292f] hover:bg-[#32383f] text-white rounded-md h-9 px-4 text-sm font-medium transition-colors inline-flex items-center gap-2 disabled:opacity-50"
        >
          {isConnecting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Github className="w-4 h-4" />
          )}
          Connect to GitHub
        </button>
      </div>
    )
  }

  if (isLoadingRepos) {
    return (
      <div className="flex flex-col items-center justify-center py-10 space-y-3">
        <Loader2 className="w-5 h-5 animate-spin text-linear-text-secondary" />
        <p className="text-xs text-linear-text-tertiary">Loading repositories...</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-linear-text-tertiary" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repositories..."
          className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-9 pl-9 text-sm"
        />
      </div>

      <div className="max-h-[240px] overflow-y-auto space-y-0.5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-linear-border">
        {filteredRepos.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-xs text-linear-text-tertiary">
              {search ? "No matching repositories" : "No repositories found"}
            </p>
          </div>
        ) : (
          filteredRepos.map((repo) => (
            <RepoItem
              key={repo.id}
              repo={repo}
              isSelected={selectedRepo?.id === repo.id}
              onSelect={() =>
                onSelectRepo(selectedRepo?.id === repo.id ? null : repo)
              }
            />
          ))
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
          GitHub repository URL
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
          Paste a link to any public or private GitHub repository
        </p>
      </div>
    </div>
  )
}

function ProjectStep({
  teamId,
  onComplete,
}: {
  teamId: string
  onComplete: (result: { teamId: string; projectId: string }) => void
}) {
  const [activeTab, setActiveTab] = useState<ProjectTab>("github")
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepo | null>(null)
  const [repoUrl, setRepoUrl] = useState("")
  const [projectName, setProjectName] = useState("")
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    if (selectedRepo) {
      setProjectName(selectedRepo.name)
    }
  }, [selectedRepo])

  useEffect(() => {
    if (activeTab === "link" && repoUrl && !projectName) {
      const match = repoUrl.match(/github\.com\/[^/]+\/([^/]+?)(?:\.git)?$/)
      if (match) {
        setProjectName(match[1])
      }
    }
  }, [repoUrl, activeTab, projectName])

  const resolvedRepoUrl = useMemo(() => {
    if (activeTab === "github" && selectedRepo) {
      return `https://github.com/${selectedRepo.full_name}`
    }
    if (activeTab === "link" && repoUrl.trim()) {
      return repoUrl.trim()
    }
    return undefined
  }, [activeTab, selectedRepo, repoUrl])

  const canCreate = projectName.trim().length > 0

  const handleCreate = useCallback(async () => {
    if (!canCreate) return

    setIsCreating(true)
    try {
      const project = await createProject({
        name: projectName.trim(),
        teamIds: [teamId],
        repoUrl: resolvedRepoUrl,
      })
      onComplete({ teamId, projectId: project.id })
    } catch {
      toast.error("Failed to create project. Please try again.")
    } finally {
      setIsCreating(false)
    }
  }, [canCreate, projectName, teamId, resolvedRepoUrl, onComplete])

  const tabs: { id: ProjectTab; label: string; icon: typeof Github }[] = [
    { id: "github", label: "GitHub Repos", icon: Github },
    { id: "link", label: "Enter Link", icon: ExternalLink },
  ]

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-xl bg-linear-accent/10 flex items-center justify-center mb-4">
          <FolderKanban className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">
          Create Your First Project
        </h2>
        <p className="text-sm text-linear-text-secondary">
          Connect a GitHub repository to start creating issues.
        </p>
      </div>

      <div className="flex rounded-lg bg-linear-bg-tertiary p-0.5 border border-linear-border">
        {tabs.map((tab) => {
          const Icon = tab.icon
          const isActive = activeTab === tab.id
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id)
                if (tab.id === "github") setRepoUrl("")
                if (tab.id === "link") setSelectedRepo(null)
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 h-8 rounded-md text-xs font-medium transition-all ${
                isActive
                  ? "bg-linear-bg-secondary text-linear-text shadow-sm"
                  : "text-linear-text-tertiary hover:text-linear-text-secondary"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {tab.label}
            </button>
          )
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
        >
          {activeTab === "github" ? (
            <GitHubRepoTab
              selectedRepo={selectedRepo}
              onSelectRepo={setSelectedRepo}
            />
          ) : (
            <LinkTab repoUrl={repoUrl} onUrlChange={setRepoUrl} />
          )}
        </motion.div>
      </AnimatePresence>

      <div className="space-y-1.5">
        <label htmlFor="onboarding-project-name" className="text-xs font-medium text-linear-text-secondary">
          Project name
        </label>
        <Input
          id="onboarding-project-name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="e.g., Web App"
          className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
        />
      </div>

      <button
        type="button"
        onClick={handleCreate}
        disabled={isCreating || !canCreate}
        className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
      >
        {isCreating ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Creating project...
          </>
        ) : (
          "Create Project"
        )}
      </button>
    </div>
  )
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

function TeamStep({
  team,
  onTeamReady,
}: {
  team: Team | null
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
    if (team) {
      onTeamReady(team)
    }
  }, [team, onTeamReady])

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
  }, [canCreate, name, key, onTeamReady])

  if (team) {
    return (
      <div className="space-y-5">
        <div className="text-center space-y-2">
          <div className="w-12 h-12 mx-auto rounded-xl bg-linear-accent/10 flex items-center justify-center mb-4">
            <Users2 className="w-6 h-6 text-linear-accent" />
          </div>
          <h2 className="text-xl font-semibold text-linear-text">Team Ready</h2>
          <p className="text-sm text-linear-text-secondary">
            We’ll create your first project inside <span className="text-linear-text">{team.name}</span>.
          </p>
        </div>

        <div className="rounded-lg border border-linear-border bg-linear-bg-tertiary px-4 py-3">
          <div className="text-[10px] uppercase tracking-[0.16em] text-linear-text-tertiary">Team</div>
          <div className="text-sm font-medium text-linear-text truncate">{team.name}</div>
          <div className="text-xs text-linear-text-tertiary mt-0.5">Key: {team.key}</div>
        </div>

        <button
          type="button"
          onClick={() => onTeamReady(team)}
          className="w-full bg-linear-accent hover:bg-linear-accent-hover text-white rounded-md h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-xl bg-linear-accent/10 flex items-center justify-center mb-4">
          <Users2 className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">Create Your Team</h2>
        <p className="text-sm text-linear-text-secondary">Set up a team to organize projects and issues.</p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="onboarding-team-name" className="text-xs font-medium text-linear-text-secondary">Team name</label>
          <Input
            id="onboarding-team-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Platform"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="onboarding-team-key" className="text-xs font-medium text-linear-text-secondary">Team key</label>
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
          <p className="text-xs text-linear-text-tertiary">
            Uppercase letters/numbers, starts with a letter.
          </p>
        </div>
      </div>

      <button
        type="button"
        onClick={handleCreate}
        disabled={isCreating || !canCreate}
        className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
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
  )
}

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  const stepKeys = useMemo(
    () => Array.from({ length: totalSteps }, (_, i) => `step-${i}`),
    [totalSteps]
  )

  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {stepKeys.map((stepKey, index) => {
        const isActive = index === currentStep
        const isCompleted = index < currentStep

        return (
          <div key={stepKey} className="flex items-center">
            <motion.div
              initial={false}
              animate={{
                backgroundColor: isCompleted
                  ? "rgb(34, 197, 94)"
                  : isActive
                    ? "rgb(29, 78, 216)"
                    : "rgb(42, 42, 42)",
              }}
              className="w-2.5 h-2.5 rounded-full transition-colors"
            />
            {index < totalSteps - 1 && (
              <div
                className={`w-8 h-px mx-1 ${
                  isCompleted ? "bg-green-500" : "bg-linear-border"
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

export function OnboardingWizard({ teams, onComplete }: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)

  const [teamFlow, setTeamFlow] = useState(false)
  const [createdTeam, setCreatedTeam] = useState<Team | null>(null)

  const team = createdTeam || teams[0] || null

  const handleWelcomeNext = useCallback(() => {
    if (!teams[0]) {
      setTeamFlow(true)
    }
    setCurrentStep(1)
  }, [teams])

  const handleTeamReady = useCallback((t: Team) => {
    setCreatedTeam(t)
    if (teamFlow) {
      setCurrentStep(2)
    }
  }, [teamFlow])

  const steps = teamFlow
    ? [
        <WelcomeStep key="welcome" onNext={handleWelcomeNext} />,
        <TeamStep key="team" team={team} onTeamReady={handleTeamReady} />,
        team ? (
          <ProjectStep key="project" teamId={team.id} onComplete={onComplete} />
        ) : (
          <div key="project" className="text-center text-linear-text-secondary">
            Create a team to continue.
          </div>
        ),
      ]
    : [
        <WelcomeStep key="welcome" onNext={handleWelcomeNext} />,
        team ? (
          <ProjectStep key="project" teamId={team.id} onComplete={onComplete} />
        ) : (
          <TeamStep key="team" team={null} onTeamReady={handleTeamReady} />
        ),
      ]

  return (
    <div className="w-full max-w-md mx-auto">
      <StepIndicator currentStep={currentStep} totalSteps={teamFlow ? 3 : 2} />

      <AnimatePresence mode="wait">
        <motion.div
          key={currentStep}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={SPRING}
          className="bg-linear-bg-secondary border border-linear-border rounded-xl p-6"
        >
          {steps[currentStep]}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
