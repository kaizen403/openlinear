import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./fetch', () => ({
  apiFetch: vi.fn(),
}))

const { apiFetch } = await import('./fetch')
const {
  BULK_TASK_LIMIT,
  bulkArchiveTasks,
  bulkCreateTasks,
  bulkDeleteTasks,
  bulkUpdateTaskStatus,
  createTaskWithKey,
} = await import('./task-commands.ts')

const ids = (count) => Array.from({ length: count }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)

describe('task commands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    apiFetch.mockResolvedValue({})
  })

  it('creates a task with the Idempotency-Key header', async () => {
    await createTaskWithKey({ title: 'New', projectId: 'p1', status: 'todo' }, 'key-123456')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ title: 'New', projectId: 'p1', status: 'todo' }),
      headers: { 'Idempotency-Key': 'key-123456' },
    })
  })

  it('bulk-creates with the Idempotency-Key header and refuses empty or oversized batches', async () => {
    await bulkCreateTasks({ projectId: 'p1', tasks: [{ title: 'A' }, { title: 'B' }] }, 'key-bulk-1')
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/bulk', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', tasks: [{ title: 'A' }, { title: 'B' }] }),
      headers: { 'Idempotency-Key': 'key-bulk-1' },
    })
    await expect(bulkCreateTasks({ projectId: 'p1', tasks: [] }, 'key-bulk-2')).rejects.toBeInstanceOf(RangeError)
    await expect(bulkCreateTasks({ projectId: 'p1', tasks: Array.from({ length: 101 }, () => ({ title: 'x' })) }, 'key-bulk-3')).rejects.toBeInstanceOf(RangeError)
    expect(apiFetch).toHaveBeenCalledTimes(1)
  })

  it('sends bulk status changes to PATCH /api/tasks/bulk-status', async () => {
    await bulkUpdateTaskStatus({ projectId: 'p1', status: 'done', taskIds: ['t1', 't2'] })
    expect(apiFetch).toHaveBeenCalledWith('/api/tasks/bulk-status', {
      method: 'PATCH',
      body: JSON.stringify({ projectId: 'p1', status: 'done', taskIds: ['t1', 't2'] }),
    })
  })

  it('never sends a bulk status change without ids (the API would update the whole project)', async () => {
    await expect(bulkUpdateTaskStatus({ projectId: 'p1', status: 'done', taskIds: [] })).rejects.toBeInstanceOf(RangeError)
    await expect(bulkUpdateTaskStatus({ projectId: 'p1', status: 'done', taskIds: ids(BULK_TASK_LIMIT + 1) })).rejects.toBeInstanceOf(RangeError)
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('sends team-only selections with teamId instead of projectId', async () => {
    await bulkUpdateTaskStatus({ teamId: 'team-1', status: 'done', taskIds: ['t1'] })
    expect(apiFetch).toHaveBeenLastCalledWith('/api/tasks/bulk-status', {
      method: 'PATCH',
      body: JSON.stringify({ teamId: 'team-1', status: 'done', taskIds: ['t1'] }),
    })
    await bulkArchiveTasks({ teamId: 'team-1', taskIds: ['t1'] })
    expect(apiFetch).toHaveBeenLastCalledWith('/api/tasks/bulk-archive', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'team-1', taskIds: ['t1'] }),
    })
    await bulkDeleteTasks({ teamId: 'team-1', taskIds: ['t1'], permanent: true })
    expect(apiFetch).toHaveBeenLastCalledWith('/api/tasks/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ teamId: 'team-1', taskIds: ['t1'], permanent: true }),
    })
  })

  it('refuses a bulk request without exactly one of projectId or teamId (BULK_SCOPE_INVALID footgun)', async () => {
    await expect(bulkUpdateTaskStatus({ status: 'done', taskIds: ['t1'] })).rejects.toBeInstanceOf(RangeError)
    await expect(bulkArchiveTasks({ projectId: 'p1', teamId: 'team-1', taskIds: ['t1'] })).rejects.toBeInstanceOf(RangeError)
    await expect(bulkDeleteTasks({ projectId: '', taskIds: ['t1'], permanent: true })).rejects.toBeInstanceOf(RangeError)
    await expect(bulkArchiveTasks({ teamId: 'team-1', taskIds: [] })).rejects.toBeInstanceOf(RangeError)
    expect(apiFetch).not.toHaveBeenCalled()
  })

  it('archives and deletes through the bulk endpoints', async () => {
    await bulkArchiveTasks({ projectId: 'p1', taskIds: ['t1'] })
    expect(apiFetch).toHaveBeenLastCalledWith('/api/tasks/bulk-archive', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', taskIds: ['t1'] }),
    })
    await bulkDeleteTasks({ projectId: 'p1', taskIds: ['t1', 't2'], permanent: true })
    expect(apiFetch).toHaveBeenLastCalledWith('/api/tasks/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'p1', taskIds: ['t1', 't2'], permanent: true }),
    })
  })
})
