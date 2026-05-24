"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { motion, AnimatePresence, useReducedMotion } from "framer-motion"
import { ArrowLeft } from "lucide-react"
import { toast } from "sonner"
import { createProject, createWorkspace, createTeam, importRepo } from "@/lib/api"
import { useAuth } from "@/hooks/use-auth"
import { WorkspaceStep } from "./steps/workspace-step"
import { ProjectStep } from "./steps/project-step"
import { TeamStep } from "./steps/team-step"
import { StepIndicator } from "./steps/step-indicator"
import {
  type RepoDraft,
  SPRING,
  EMPTY_REPO_DRAFT,
  clearStoredDraft,
  deriveDefaultTeamName,
  deriveTeamKey,
  getRepoUrl,
  loadStoredDraft,
  saveStoredDraft,
} from "./steps/onboarding-utils"

interface OnboardingWizardProps {
  initialWorkspaceId?: string | null
  initialProjectId?: string | null
  initialProjectName?: string | null
  onComplete: (result: { teamId: string; projectId: string; workspaceId: string }) => void
  onCancel?: () => void
}

export function OnboardingWizard({
  initialWorkspaceId = null,
  initialProjectId = null,
  initialProjectName = null,
  onComplete,
  onCancel,
}: OnboardingWizardProps) {
  const [currentStep, setCurrentStep] = useState(0)
  const [workspaceName, setWorkspaceName] = useState("")
  const [projectName, setProjectName] = useState(initialProjectName ?? "")
  const [teamName, setTeamName] = useState(() => (initialProjectId ? deriveDefaultTeamName(initialProjectName) : ""))
  const [repoDraft, setRepoDraft] = useState<RepoDraft>(EMPTY_REPO_DRAFT)
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(initialWorkspaceId)
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(initialProjectId)
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
      const restoredProjectId = initialProjectId ?? storedDraft.createdProjectId ?? null
      let restoredStep = restoredWorkspaceId ? storedDraft.currentStep : 0
      if (restoredWorkspaceId && restoredStep === 0) restoredStep = 1
      if (restoredProjectId) restoredStep = 2
      if (restoredStep === 2 && !restoredProjectId) restoredStep = 1
      setCurrentStep(Math.min(Math.max(restoredStep, 0), 2))
      setWorkspaceName(storedDraft.workspaceName)
      const restoredProjectName = initialProjectName || storedDraft.projectName
      setProjectName(restoredProjectName)
      setRepoDraft(storedDraft.repoDraft)
      setTeamName(storedDraft.teamName || (restoredProjectId ? deriveDefaultTeamName(restoredProjectName) : ""))
      setCreatedWorkspaceId(restoredWorkspaceId)
      setCreatedProjectId(restoredProjectId)
    } else if (initialWorkspaceId) {
      setCreatedWorkspaceId(initialWorkspaceId)
      setCreatedProjectId(initialProjectId)
      setProjectName(initialProjectName ?? "")
      setTeamName(initialProjectId ? deriveDefaultTeamName(initialProjectName) : "")
      setCurrentStep(initialProjectId ? 2 : 1)
    }
    didLoadStoredDraftRef.current = true
  }, [initialWorkspaceId, initialProjectId, initialProjectName])

  useEffect(() => {
    if (!initialWorkspaceId) return
    setCreatedWorkspaceId((current) => current ?? initialWorkspaceId)
  }, [initialWorkspaceId])

  useEffect(() => {
    if (!initialProjectId) return
    setCreatedProjectId((current) => current ?? initialProjectId)
    setProjectName((current) => current || initialProjectName || "")
    setTeamName((current) => current || deriveDefaultTeamName(initialProjectName))
    setCurrentStep((step) => (step < 2 ? 2 : step))
  }, [initialProjectId, initialProjectName])

  // Save draft
  useEffect(() => {
    if (!didLoadStoredDraftRef.current) return
    saveStoredDraft({ currentStep, workspaceName, projectName, repoDraft, teamName, createdWorkspaceId, createdProjectId })
  }, [currentStep, workspaceName, projectName, repoDraft, teamName, createdWorkspaceId, createdProjectId])

  const updateRepoDraft = useCallback((patch: Partial<RepoDraft>) => {
    setRepoDraft((current) => ({ ...current, ...patch }))
  }, [])

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

  const handleCreateProject = useCallback(async () => {
    if (initialProjectId && createdProjectId === initialProjectId) {
      setTeamName((current) => current || deriveDefaultTeamName(projectName || initialProjectName))
      setCurrentStep(2)
      return
    }

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
      setTeamName((current) => current || deriveDefaultTeamName(project.name))
      setCurrentStep(2)
    } catch {
      toast.error("Failed to create project. Please try again.")
    } finally {
      setIsWorking(false)
    }
  }, [projectName, createdWorkspaceId, initialWorkspaceId, initialProjectId, initialProjectName, createdProjectId, repoDraft])

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
            isExistingProject={Boolean(initialProjectId && createdProjectId === initialProjectId)}
            onProjectNameChange={setProjectName}
            onRepoDraftChange={updateRepoDraft}
            onBack={initialProjectId ? undefined : () => setCurrentStep(0)}
            onCreate={handleCreateProject}
          />
        )
      case 2:
        return (
          <TeamStep
            projectName={projectName || initialProjectName || undefined}
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
