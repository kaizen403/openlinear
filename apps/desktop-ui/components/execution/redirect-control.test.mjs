import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'

const api = vi.hoisted(() => ({ redirectTask: null }))
vi.mock('@/lib/api/review', async (original) => ({ ...(await original()), redirectTask: (...args) => api.redirectTask(...args) }))
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

const { RedirectControl } = await import('./redirect-control.tsx')
const { ApiError } = await import('@/lib/api/fetch.ts')

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('RedirectControl (W12 stop and redirect)', () => {
  it('sends the new direction and reports the follow-up turn', async () => {
    api.redirectTask = vi.fn(async () => ({ runId: 'run-2', attemptId: 'a2', state: 'running' }))
    const onRedirected = vi.fn()
    render(createElement(RedirectControl, { taskId: 't1', onRedirected }))
    fireEvent.click(screen.getByRole('button', { name: 'Redirect the agent' }))
    const send = await screen.findByRole('button', { name: 'Stop and redirect' })
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Only fix the null check  ' } })
    fireEvent.click(send)
    await waitFor(() => expect(api.redirectTask).toHaveBeenCalledWith('t1', 'Only fix the null check'))
    await waitFor(() => expect(onRedirected).toHaveBeenCalledWith({ runId: 'run-2', attemptId: 'a2', state: 'running' }))
    expect(toasts.success).toHaveBeenCalledWith('Redirected', expect.anything())
  })

  it('explains a stop that is still in progress', async () => {
    api.redirectTask = vi.fn(async () => { throw new ApiError(409, "The agent hasn't stopped yet", 'REDIRECT_PENDING') })
    render(createElement(RedirectControl, { taskId: 't1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Redirect the agent' }))
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Stop and redirect' }))
    await waitFor(() => expect(toasts.error).toHaveBeenCalled())
    expect(toasts.error.mock.calls[0][0]).toBe("The agent hasn't stopped yet.")
  })
})
