import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement } from 'react'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    custom: vi.fn(),
  },
  Toaster: () => null,
}))

vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: vi.fn(),
}))

vi.mock('@/hooks/use-workspace', () => ({
  useWorkspace: () => ({ activeWorkspace: { id: 'ws1', name: 'Test' }, isLoading: false }),
}))

vi.mock('@/lib/api', () => ({
  fetchProjects: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(status, message, code, details) {
      super(message)
      this.status = status
      this.code = code
      this.details = details
      this.name = 'ApiError'
    }
  },
}))

const { fetchProjects, createProject, updateProject, deleteProject, ApiError } = await import('@/lib/api')
const { useProjects, mapErrorToForm, projectToFormData, emptyFormData } = await import('./use-projects.ts')

describe('useProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads projects when workspace is active', async () => {
    const projects = [{ id: 'p1', name: 'Proj1', status: 'planned' }]
    fetchProjects.mockResolvedValue(projects)

    const { result } = renderHook(() => useProjects())

    await waitFor(() => {
      expect(result.current.projects).toEqual(projects)
    })
    expect(fetchProjects).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws1',
    }))
  })

  it('sets empty projects when no workspace', async () => {
    const originalWorkspace = await import('@/hooks/use-workspace')
    vi.doMock('@/hooks/use-workspace', () => ({
      useWorkspace: () => ({ activeWorkspace: null, isLoading: false }),
    }))

    const { useProjects: useProjects2 } = await import('./use-projects.ts')
    const { result } = renderHook(() => useProjects2())

    await waitFor(() => {
      expect(result.current.projects).toEqual([])
    })

    vi.doUnmock('@/hooks/use-workspace')
  })

  it('handleCreateProject calls createProject and reloads', async () => {
    const projects = [{ id: 'p1', name: 'Proj1', status: 'planned' }]
    fetchProjects.mockResolvedValue(projects)
    createProject.mockResolvedValue({ id: 'p2' })

    const { result } = renderHook(() => useProjects())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const formData = { ...emptyFormData, name: 'New Project', status: 'planned', sourceType: 'none', repoUrl: '', localPath: '', targetDate: '', description: '' }
    await result.current.handleCreateProject(formData, false)

    expect(createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Project',
      workspaceId: 'ws1',
    }))
    expect(fetchProjects).toHaveBeenCalledTimes(2)
  })

  it('handleUpdateProject calls updateProject and reloads', async () => {
    const projects = [{ id: 'p1', name: 'Proj1', status: 'planned' }]
    fetchProjects.mockResolvedValue(projects)
    updateProject.mockResolvedValue({ id: 'p1' })

    const { result } = renderHook(() => useProjects())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    const formData = { ...emptyFormData, name: 'Updated', status: 'in_progress', sourceType: 'none', repoUrl: '', localPath: '', targetDate: '', description: '' }
    await result.current.handleUpdateProject('p1', formData, false, null)

    expect(updateProject).toHaveBeenCalledWith('p1', expect.objectContaining({
      name: 'Updated',
      status: 'in_progress',
    }))
  })

  it('handleDeleteProject calls deleteProject and reloads', async () => {
    const projects = [{ id: 'p1', name: 'Proj1', status: 'planned' }]
    fetchProjects.mockResolvedValue(projects)
    deleteProject.mockResolvedValue(undefined)

    const { result } = renderHook(() => useProjects())
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await result.current.handleDeleteProject('p1')

    expect(deleteProject).toHaveBeenCalledWith('p1')
    expect(fetchProjects).toHaveBeenCalledTimes(2)
  })
})

describe('mapErrorToForm', () => {
  it('returns ApiError details as form errors', () => {
    const err = new ApiError(400, 'Bad request', 'VALIDATION_ERROR', {
      fieldErrors: { name: ['Name is required'] },
    })
    const result = mapErrorToForm(err, 'Fallback')
    expect(result.formErrors.name).toBe('Name is required')
    expect(result.toastMessage).toBe('Bad request')
  })

  it('returns fallback for non-ApiError', () => {
    const result = mapErrorToForm(new Error('Random'), 'Fallback msg')
    expect(result.toastMessage).toBe('Fallback msg')
    expect(result.formErrors._root).toBe('Fallback msg')
  })

  it('handles OWNERSHIP_REQUIRED code', () => {
    const err = new ApiError(403, 'Forbidden', 'OWNERSHIP_REQUIRED')
    const result = mapErrorToForm(err, 'Fallback')
    expect(result.formErrors._root).toBe("You don't have permission to perform this action.")
  })
})

describe('projectToFormData', () => {
  it('maps project to form data correctly', () => {
    const project = {
      id: 'p1',
      name: 'Test',
      description: 'Desc',
      status: 'in_progress',
      targetDate: '2024-01-01T00:00:00Z',
      repoUrl: 'https://github.com/test/repo',
      localPath: null,
    }
    const result = projectToFormData(project)
    expect(result.name).toBe('Test')
    expect(result.description).toBe('Desc')
    expect(result.status).toBe('in_progress')
    expect(result.targetDate).toBe('2024-01-01')
    expect(result.sourceType).toBe('repo')
    expect(result.repoUrl).toBe('https://github.com/test/repo')
    expect(result.localPath).toBe('')
  })

  it('handles local source type', () => {
    const project = {
      id: 'p1',
      name: 'Test',
      description: null,
      status: 'planned',
      targetDate: null,
      repoUrl: null,
      localPath: '/home/project',
    }
    const result = projectToFormData(project)
    expect(result.sourceType).toBe('local')
    expect(result.localPath).toBe('/home/project')
  })
})
