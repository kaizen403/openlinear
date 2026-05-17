"use client"

import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from "react"
import { fetchProjects, Project } from "@/lib/api"

interface ProjectContextType {
  activeProject: Project | null
  projects: Project[]
  isLoading: boolean
  setActiveProject: (project: Project) => void
  refreshProjects: () => Promise<void>
}

const ProjectContext = createContext<ProjectContextType | undefined>(undefined)

const STORAGE_KEY = "openlinear:activeProjectId"

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProjectState] = useState<Project | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const loadProjects = useCallback(async () => {
    try {
      const data = await fetchProjects()
      setProjects(data)
      return data
    } catch {
      setProjects([])
      return []
    }
  }, [])

  const setActiveProject = useCallback((project: Project) => {
    setActiveProjectState(project)
    localStorage.setItem(STORAGE_KEY, project.id)
  }, [])

  const refreshProjects = useCallback(async () => {
    await loadProjects()
  }, [loadProjects])

  useEffect(() => {
    (async () => {
      const data = await loadProjects()
      const savedId = localStorage.getItem(STORAGE_KEY)
      if (savedId) {
        const found = data.find((p) => p.id === savedId)
        if (found) {
          setActiveProjectState(found)
        } else if (data.length > 0) {
          setActiveProjectState(data[0])
          localStorage.setItem(STORAGE_KEY, data[0].id)
        }
      } else if (data.length > 0) {
        setActiveProjectState(data[0])
        localStorage.setItem(STORAGE_KEY, data[0].id)
      }
      setIsLoading(false)
    })()
  }, [loadProjects])

  return (
    <ProjectContext.Provider value={{ activeProject, projects, isLoading, setActiveProject, refreshProjects }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  const context = useContext(ProjectContext)
  if (!context) {
    throw new Error("useProject must be used within a ProjectProvider")
  }
  return context
}
