import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fetch', () => ({
  apiFetch: vi.fn(),
}))

const { apiFetch } = await import('./fetch')
const {
  fetchMyIssues,
  createTask,
  executeTaskPublic,
  fetchInboxCount,
  fetchExecutionLogs,
  fetchProjectIssues,
  refreshTaskPr,
  markInboxRead,
  markAllInboxRead,
} = await import('./tasks')

describe('tasks API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetchMyIssues with default filter', async () => {
    apiFetch.mockResolvedValue([{ id: 't1', title: 'Task' }])
    const result = await fetchMyIssues()
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks?assignee=me')
    expect(result).toEqual([{ id: 't1', title: 'Task' }])
  })

  it('fetchMyIssues with created filter', async () => {
    apiFetch.mockResolvedValue([])
    await fetchMyIssues('created')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks?creator=me')
  })

  it('fetchMyIssues with all filter', async () => {
    apiFetch.mockResolvedValue([])
    await fetchMyIssues('all')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks')
  })

  it('fetchProjectIssues', async () => {
    apiFetch.mockResolvedValue([])
    await fetchProjectIssues('p1')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks?projectId=p1')
  })

  it('createTask', async () => {
    apiFetch.mockResolvedValue({ id: 't1', title: 'New' })
    const result = await createTask({ title: 'New', teamId: 'team1' })
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'New', teamId: 'team1' }),
    })
    expect(result).toEqual({ id: 't1', title: 'New' })
  })

  it('executeTaskPublic calls sidecar', async () => {
    apiFetch.mockResolvedValue(undefined)
    await executeTaskPublic('t1')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/t1/execute', {
      method: 'POST',
      sidecar: true,
    })
  })

  it('fetchInboxCount returns count', async () => {
    apiFetch.mockResolvedValue({ total: 5, unread: 2 })
    const result = await fetchInboxCount()
    expect(result).toEqual({ total: 5, unread: 2 })
  })

  it('fetchInboxCount returns zero on error', async () => {
    apiFetch.mockRejectedValue(new Error('fail'))
    const result = await fetchInboxCount()
    expect(result).toEqual({ total: 0, unread: 0 })
  })

  it('markInboxRead', async () => {
    apiFetch.mockResolvedValue(undefined)
    await markInboxRead('t1')
    expect(apiFetch).toHaveBeenCalledWith('/api/inbox/read/t1', { method: 'PATCH' })
  })

  it('markAllInboxRead', async () => {
    apiFetch.mockResolvedValue(undefined)
    await markAllInboxRead()
    expect(apiFetch).toHaveBeenCalledWith('/api/inbox/read-all', { method: 'PATCH' })
  })

  it('refreshTaskPr calls sidecar', async () => {
    apiFetch.mockResolvedValue({ prUrl: null, refreshed: true })
    const result = await refreshTaskPr('t1')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/t1/refresh-pr', {
      method: 'POST',
      sidecar: true,
    })
    expect(result).toEqual({ prUrl: null, refreshed: true })
  })

  it('fetchExecutionLogs calls sidecar', async () => {
    apiFetch.mockResolvedValue({ logs: [] })
    const result = await fetchExecutionLogs('t1')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/t1/logs', { sidecar: true })
    expect(result).toEqual({ logs: [] })
  })
})
