import { describe, it, expect } from 'vitest'

const { decodeExecutionEvent, eventBelongsToTask } = await import('./decode.ts')
const { summarizeToolInput, toolTitle } = await import('./tool-summary.ts')
const { classifyLegacyLog } = await import('./legacy.ts')

describe('decodeExecutionEvent', () => {
  it('decodes legacy progress and log payloads with their SSE id', () => {
    expect(decodeExecutionEvent('execution:progress', { taskId: 't1', status: 'creating_pr', message: 'Creating pull request...' }, { id: '42' }, 5))
      .toEqual({ kind: 'progress', id: '42', taskId: 't1', status: 'creating_pr', message: 'Creating pull request...', prUrl: null, isCompareLink: false, receivedAt: 5 })
    expect(decodeExecutionEvent('execution:log', { taskId: 't1', entry: { timestamp: '2026-10-25T10:00:00.000Z', type: 'tool', message: 'Running: bash' } }, { id: '43' }))
      .toMatchObject({ kind: 'log', id: '43', taskId: 't1', entry: { type: 'tool', message: 'Running: bash' } })
  })

  it('decodes run-journal progress (live and replayed) and recovers runId/seq from the SSE id', () => {
    expect(decodeExecutionEvent('execution:progress', { runId: 'r1', taskId: 't1', seq: 3, type: 'tool.started', payload: { t: 'tool.started' } }, { id: 'run:r1:3' }))
      .toMatchObject({ kind: 'journal', runId: 'r1', seq: 3, taskId: 't1', type: 'tool.started' })
    // Sidecar-local delivery omits taskId; replay omits `at`.
    expect(decodeExecutionEvent('execution:progress', { type: 'usage', payload: {} }, { id: 'run:r9:12' }))
      .toMatchObject({ kind: 'journal', runId: 'r9', seq: 12, taskId: null })
  })

  it('returns null for malformed or foreign payloads instead of throwing', () => {
    expect(decodeExecutionEvent('execution:progress', null)).toBeNull()
    expect(decodeExecutionEvent('execution:progress', { taskId: 't1', status: 'weird' })).toBeNull()
    expect(decodeExecutionEvent('execution:log', { taskId: 't1', entry: { message: 'no timestamp', type: 'info' } })).toBeNull()
    expect(decodeExecutionEvent('execution:log', { taskId: 't1', entry: { timestamp: 'x', message: 'bad type', type: 'debug' } })).toBeNull()
    expect(decodeExecutionEvent('task:updated', { id: 't1' })).toBeNull()
  })

  it('routes journal events without a taskId by their run', () => {
    const event = decodeExecutionEvent('execution:progress', { runId: 'r1', seq: 1, type: 'heartbeat', payload: {} }, { id: 'run:r1:1' })
    expect(eventBelongsToTask(event, 't1', () => false)).toBe(false)
    expect(eventBelongsToTask(event, 't1', (runId) => runId === 'r1')).toBe(true)
  })
})

describe('tool presentation', () => {
  it('derives the single most identifying argument per tool', () => {
    expect(summarizeToolInput('read', { filePath: '/repo/src/app.ts' })).toBe('app.ts')
    expect(summarizeToolInput('bash', { command: 'pnpm   test\n --watch=false' })).toBe('pnpm test --watch=false')
    expect(summarizeToolInput('grep', { pattern: 'TODO' })).toBe('TODO')
    expect(summarizeToolInput('webfetch', { url: 'https://example.com' })).toBe('https://example.com')
    expect(summarizeToolInput('mcp__github__create_issue', { title: 'Bug', body: 'x' })).toBe('Bug')
    expect(summarizeToolInput('read', 42)).toBeNull()
  })

  it('titles known tools and degrades MCP/unknown tools to a readable name', () => {
    expect(toolTitle('bash')).toBe('Shell')
    expect(toolTitle('edit')).toBe('Edit')
    expect(toolTitle('mcp__github__create_issue')).toBe('github · create issue')
    expect(toolTitle(null)).toBe('Tool')
  })

  it('classifies the sidecar log vocabulary', () => {
    const at = '2026-10-25T10:00:00.000Z'
    expect(classifyLegacyLog({ timestamp: at, type: 'agent', message: 'Thinking: hmm' })).toEqual({ t: 'reasoning', text: 'hmm' })
    expect(classifyLegacyLog({ timestamp: at, type: 'success', message: 'Edited file: a.ts' })).toEqual({ t: 'file', path: 'a.ts' })
    expect(classifyLegacyLog({ timestamp: at, type: 'error', message: 'Failed: bash', details: 'exit 1' })).toEqual({ t: 'tool-end', name: 'bash', ok: false, output: 'exit 1' })
    expect(classifyLegacyLog({ timestamp: at, type: 'info', message: 'Creating pull request...' })).toMatchObject({ t: 'system', phase: 'publishing' })
    expect(classifyLegacyLog({ timestamp: at, type: 'info', message: 'Retrying: overloaded' })).toMatchObject({ t: 'system', tone: 'warning' })
  })
})
