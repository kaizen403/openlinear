"use client"

import { useState, useEffect, useCallback } from "react"
import { motion, AnimatePresence } from "framer-motion"
import {
  Rocket,
  Check,
  Users,
  FolderKanban,
  Globe,
  ArrowRight,
  Loader2,
  Sparkles,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "sonner"
import { createProject, updateTeam, type Team, type Project } from "@/lib/api"

const SPRING = { type: "spring" as const, stiffness: 300, damping: 30 }

interface OnboardingWizardProps {
  teams: Team[]
  onComplete: (projectId: string) => void
}

function generateTeamKey(name: string): string {
  const words = name.trim().split(/\s+/)
  if (words.length >= 2) {
    return words
      .slice(0, 4)
      .map((w) => w.charAt(0).toUpperCase())
      .join("")
  }
  return name.slice(0, Math.min(4, name.length)).toUpperCase()
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
          Welcome to KazCode
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

function TeamStep({
  team,
  onNext,
}: {
  team: Team
  onNext: (teamData: { name: string; key: string; description: string }) => void
}) {
  const [name, setName] = useState(team.name)
  const [key, setKey] = useState(team.key)
  const [description, setDescription] = useState(team.description || "")
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    const generatedKey = generateTeamKey(name)
    if (generatedKey !== key) {
      setKey(generatedKey)
    }
  }, [name])

  const handleContinue = useCallback(async () => {
    if (!name.trim()) {
      toast.error("Team name is required")
      return
    }

    setIsLoading(true)
    try {
      if (name !== team.name || description !== team.description) {
        await updateTeam(team.id, {
          name: name.trim(),
          description: description.trim() || null,
        })
      }
      onNext({ name: name.trim(), key, description: description.trim() })
    } catch {
      toast.error("Failed to update team. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }, [name, key, description, team, onNext])

  const handleSkip = useCallback(() => {
    onNext({ name: team.name, key: team.key, description: team.description || "" })
  }, [team, onNext])

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <div className="w-12 h-12 mx-auto rounded-xl bg-linear-accent/10 flex items-center justify-center mb-4">
          <Users className="w-6 h-6 text-linear-accent" />
        </div>
        <h2 className="text-xl font-semibold text-linear-text">Your Team</h2>
        <p className="text-sm text-linear-text-secondary">
          We created a team for you. Customize it or continue.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-linear-text-secondary">
            Team name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Engineering"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-linear-text-secondary">
            Team key
          </label>
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="ENG"
            maxLength={4}
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10 uppercase"
          />
          <p className="text-xs text-linear-text-tertiary">
            Used for issue identifiers (e.g., ENG-123)
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-linear-text-secondary">
            Description <span className="text-linear-text-tertiary">(optional)</span>
          </label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this team work on?"
            rows={3}
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover resize-none"
          />
        </div>
      </div>

      <div className="space-y-3">
        <button
          onClick={handleContinue}
          disabled={isLoading || !name.trim()}
          className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Continue"
          )}
        </button>

        <button
          onClick={handleSkip}
          disabled={isLoading}
          className="w-full text-sm text-linear-text-secondary hover:text-linear-text transition-colors"
        >
          Skip for now
        </button>
      </div>
    </div>
  )
}

function ProjectStep({
  teamId,
  onCreate,
}: {
  teamId: string
  onCreate: (project: Project) => void
}) {
  const [name, setName] = useState("")
  const [repoUrl, setRepoUrl] = useState("")
  const [isLoading, setIsLoading] = useState(false)

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      toast.error("Project name is required")
      return
    }

    setIsLoading(true)
    try {
      const project = await createProject({
        name: name.trim(),
        teamIds: [teamId],
        repoUrl: repoUrl.trim() || undefined,
      })
      onCreate(project)
    } catch {
      toast.error("Failed to create project. Please try again.")
    } finally {
      setIsLoading(false)
    }
  }, [name, repoUrl, teamId, onCreate])

  return (
    <div className="space-y-6">
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

      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-linear-text-secondary">
            Project name
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Web App"
            className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-linear-text-secondary">
            GitHub repository <span className="text-linear-text-tertiary">(optional)</span>
          </label>
          <div className="relative">
            <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-linear-text-tertiary" />
            <Input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="bg-linear-bg-tertiary border-linear-border text-linear-text placeholder:text-linear-text-tertiary focus:border-linear-border-hover h-10 pl-10"
            />
          </div>
        </div>
      </div>

      <button
        onClick={handleCreate}
        disabled={isLoading || !name.trim()}
        className="w-full bg-linear-accent hover:bg-linear-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-md h-10 px-6 text-sm font-medium transition-colors inline-flex items-center justify-center gap-2"
      >
        {isLoading ? (
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

function SuccessStep({
  projectName,
  onGoToProject,
}: {
  projectName: string
  onGoToProject: () => void
}) {
  return (
    <div className="text-center space-y-6">
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ ...SPRING, delay: 0.1 }}
        className="w-20 h-20 mx-auto rounded-2xl bg-green-500/10 flex items-center justify-center"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ ...SPRING, delay: 0.3 }}
        >
          <Check className="w-10 h-10 text-green-500" />
        </motion.div>
      </motion.div>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING, delay: 0.2 }}
        className="space-y-2"
      >
        <h2 className="text-2xl font-semibold text-linear-text">
          You&apos;re all set!
        </h2>
        <p className="text-sm text-linear-text-secondary max-w-xs mx-auto leading-relaxed">
          Your project <span className="text-linear-text font-medium">{projectName}</span> is ready.
          Start creating issues and let AI execute them.
        </p>
      </motion.div>

      <motion.div
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING, delay: 0.3 }}
        className="space-y-3"
      >
        <button
          onClick={onGoToProject}
          className="bg-linear-accent hover:bg-linear-accent-hover text-white rounded-md h-10 px-6 text-sm font-medium transition-colors inline-flex items-center gap-2"
        >
          Go to Project
          <ArrowRight className="w-4 h-4" />
        </button>

        <div className="flex items-center justify-center gap-2 text-xs text-linear-text-tertiary">
          <Sparkles className="w-3 h-3" />
          <span>Tip: Use Brainstorm to generate tasks from ideas</span>
        </div>
      </motion.div>
    </div>
  )
}

function StepIndicator({ currentStep, totalSteps }: { currentStep: number; totalSteps: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {Array.from({ length: totalSteps }).map((_, index) => {
        const isActive = index === currentStep
        const isCompleted = index < currentStep

        return (
          <div key={index} className="flex items-center">
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
  const [createdProject, setCreatedProject] = useState<Project | null>(null)

  const team = teams[0]

  const handleWelcomeNext = useCallback(() => {
    setCurrentStep(1)
  }, [])

  const handleTeamNext = useCallback(
    (teamData: { name: string; key: string; description: string }) => {
      void teamData
      setCurrentStep(2)
    },
    []
  )

  const handleProjectCreate = useCallback((project: Project) => {
    setCreatedProject(project)
    setCurrentStep(3)
  }, [])

  const handleGoToProject = useCallback(() => {
    if (createdProject) {
      onComplete(createdProject.id)
    }
  }, [createdProject, onComplete])

  const steps = [
    <WelcomeStep key="welcome" onNext={handleWelcomeNext} />,
    team ? (
      <TeamStep key="team" team={team} onNext={handleTeamNext} />
    ) : (
      <div key="no-team" className="text-center text-linear-text-secondary">
        No team found. Please contact support.
      </div>
    ),
    team ? (
      <ProjectStep key="project" teamId={team.id} onCreate={handleProjectCreate} />
    ) : null,
    createdProject ? (
      <SuccessStep
        key="success"
        projectName={createdProject.name}
        onGoToProject={handleGoToProject}
      />
    ) : null,
  ]

  return (
    <div className="w-full max-w-md mx-auto">
      <StepIndicator currentStep={currentStep} totalSteps={4} />

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
