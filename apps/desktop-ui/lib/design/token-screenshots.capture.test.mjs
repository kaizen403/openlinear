// Opt-in visual check for the design tokens (skipped in the normal suite).
//
//   TOKENS_SCREENSHOTS=after pnpm --filter @openlinear/desktop-ui exec vitest run lib/design/token-screenshots.capture.test.mjs
//
// Renders real components with fixture data in jsdom, serialises the DOM,
// compiles the app's real Tailwind CSS (tailwind.config.ts + app/globals.css,
// bundled fonts), and screenshots each surface with headless Chrome into
// docs/reports/revamp-2026-10-26/tokens-<surface>-<label>.png. The label is
// the env value (`before` / `after`). CHROMIUM_BIN overrides the browser.
//
// Surfaces: board, task detail with the run view, chat panel, settings, and a
// token specimen (buttons, inputs, chips, text ladder). Static snapshots: no
// layout-dependent behaviour (virtualised rows use their size estimates).
import { describe, it, vi, afterEach, beforeAll } from 'vitest'
import { render, act, cleanup } from '@testing-library/react'
import { createElement as h } from 'react'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const LABEL = process.env.TOKENS_SCREENSHOTS
const PKG = resolve(import.meta.dirname, '../..')
const OUT_DIR = resolve(PKG, '../../docs/reports/revamp-2026-10-26')
const WORK_DIR = resolve(PKG, 'node_modules/.cache/token-screenshots')
const MAX_PNG_BYTES = 300 * 1024

const fixture = vi.hoisted(() => ({
  tasks: [],
  chat: null,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/settings',
  useSearchParams: () => new URLSearchParams('section=ai-execution'),
  redirect: () => {},
}))
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    isAuthenticated: true,
    activeRepository: { id: 'repo-1', fullName: 'acme/app', defaultBranch: 'main' },
    refreshActiveRepository: () => {},
    user: { id: 'u1', username: 'harsha', avatarUrl: null },
  }),
}))
vi.mock('@/hooks/use-team-members', () => ({ useTeamMembers: () => ({ members: [], isLoading: false }) }))
vi.mock('@/providers/sse-provider', () => ({
  useSSESubscription: () => {},
  useSSEStatus: () => ({ isConnected: true, isReconnecting: false }),
}))
vi.mock('@/components/comments-thread', () => ({ CommentsThread: () => null }))
vi.mock('@/components/task-form', () => ({ TaskFormDialog: () => null }))
vi.mock('@/components/provider-setup-dialog', () => ({ ProviderSetupDialog: () => null }))
vi.mock('@/components/board/model-selector', () => ({ ModelSelector: () => null }))
vi.mock('@/lib/api/tasks', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchExecutionLogs: async () => ({ logs: [] }),
}))
vi.mock('@/lib/api/fetch', async (importOriginal) => ({
  ...(await importOriginal()),
  apiFetch: async (path) => {
    if (typeof path === 'string' && path.startsWith('/api/tasks?')) return { items: fixture.tasks }
    if (path === '/api/settings') {
      return { parallelLimit: 3, maxBatchSize: 3, queueAutoApprove: false, stopOnFailure: true, conflictBehavior: 'skip', taskDeletionMode: 'archive' }
    }
    return {}
  },
}))
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal()),
  getActiveRepository: async () => ({ id: 'repo-1', fullName: 'acme/app', defaultBranch: 'main' }),
}))
const PROJECT = { id: 'p1', name: 'Kitchen', key: 'KT', teamId: 'team-1' }
vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ activeProject: PROJECT, projects: [PROJECT], setActiveProject: () => {} }),
}))
vi.mock('@/hooks/use-workspace', () => ({ useWorkspace: () => ({ activeWorkspace: { id: 'w1', name: 'Acme' } }) }))
vi.mock('@/hooks/use-chat-panel-handoff', () => ({ useChatPanelHandoff: () => ({ consumeQuery: () => null }) }))
vi.mock('@/hooks/use-chat-sessions', () => ({
  useChatSessions: () => ({
    sessions: [
      { id: 's1', title: 'Release checklist', projectId: 'p1', createdAt: new Date(Date.now() - 3_600_000).toISOString(), lastMessageAt: new Date(Date.now() - 120_000).toISOString() },
      { id: 's2', title: 'Flaky login test', projectId: 'p1', createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), lastMessageAt: new Date(Date.now() - 86_400_000).toISOString() },
    ],
    activeSessionId: 's1',
    setActiveSessionId: () => {},
    createSession: async () => null,
    renameSession: async () => {},
  }),
}))
vi.mock('@/hooks/use-chat-stream', () => ({ useChatStream: () => fixture.chat }))
vi.mock('@/components/markdown-view', async () => {
  const { createElement } = await import('react')
  return {
    MarkdownView: ({ body, content }) => createElement('div', { className: 'whitespace-pre-wrap text-sm leading-relaxed text-linear-text' }, body ?? content),
  }
})

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function makeTask(index, overrides = {}) {
  return {
    id: ID(index),
    title: 'Task',
    description: null,
    priority: 'medium',
    status: 'todo',
    sessionId: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    labels: [],
    executionStartedAt: null,
    executionPausedAt: null,
    executionElapsedMs: 0,
    executionProgress: null,
    prUrl: null,
    outcome: null,
    batchId: null,
    inboxRead: false,
    identifier: `KT-${index}`,
    number: index,
    dueDate: null,
    projectId: 'p1',
    teamId: 'team-1',
    archived: false,
    ...overrides,
  }
}

const LABELS = {
  bug: { id: 'l1', name: 'bug', color: '#ef4444' },
  feature: { id: 'l2', name: 'feature', color: '#3b82f6' },
  phase: { id: 'l3', name: 'phase:1 — Foundations', color: '#8b5cf6' },
}

function boardTasks() {
  const tl = (...labels) => labels
  return [
    makeTask(1, { title: 'Fix the login redirect loop', priority: 'high', status: 'todo', labels: tl(LABELS.bug) }),
    makeTask(2, { title: 'Add keyboard shortcuts to the board', priority: 'high', status: 'todo', labels: tl(LABELS.feature) }),
    makeTask(3, { title: 'Document the design tokens', priority: 'low', status: 'todo' }),
    makeTask(4, { title: 'Migrate settings to the new API', priority: 'medium', status: 'todo', dueDate: '2026-11-02T00:00:00.000Z' }),
    makeTask(5, { title: 'Stream run journal to the timeline', priority: 'high', status: 'in_progress', executionStartedAt: '2026-10-25T10:00:00.000Z', executionProgress: 40, labels: tl(LABELS.phase) }),
    makeTask(6, { title: 'Contrast audit for status chips', priority: 'medium', status: 'in_progress' }),
    makeTask(7, { title: 'Ship the run header', priority: 'medium', status: 'done', prUrl: 'https://github.com/acme/app/pull/41' }),
    makeTask(8, { title: 'Remove dead brainstorm code', priority: 'low', status: 'done' }),
    makeTask(9, { title: 'Old onboarding flow', priority: 'low', status: 'cancelled' }),
  ]
}

function chatFixture() {
  const now = Date.now()
  const confirmation = {
    code: 'CONFIRM-7KQ2MX9P',
    confirmationId: 'conf-1',
    toolCallId: 'call_3',
    toolName: 'bulk_update_issues',
    summary: 'Set status to done on 2 issues',
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    preview: {
      kind: 'status_change',
      status: 'done',
      issues: [
        { id: 'i1', identifier: 'KT-7', title: 'Ship the run header', status: 'in_progress' },
        { id: 'i2', identifier: 'KT-8', title: 'Remove dead brainstorm code', status: 'todo' },
      ],
      unchangedCount: 0,
      notFound: [],
      wholeProject: false,
      argumentsText: null,
    },
  }
  const messages = [
    { id: 'm1', role: 'user', content: 'Which issues in Kitchen are blocking the release?', toolCalls: [], createdAt: new Date(now - 120_000).toISOString() },
    {
      id: 'm2',
      role: 'assistant',
      content: 'Two issues block the release:\n\n- KT-1 Fix the login redirect loop (urgent, todo)\n- KT-5 Stream run journal to the timeline (high, in progress)\n\nKT-7 and KT-8 look finished; I can mark them done.',
      toolCalls: [
        { id: 'call_1', name: 'search_issues', arguments: '{"query":"release"}', status: 'completed', effect: 'read', result: '{"items":4}', code: 'OK' },
        { id: 'call_2', name: 'get_issue', arguments: '{"id":"KT-9"}', status: 'error', effect: 'read', isError: true, code: 'NOT_FOUND', message: 'Issue not found' },
        { id: 'call_3', name: 'bulk_update_issues', arguments: '{"ids":["KT-7","KT-8"],"status":"done"}', status: 'completed', effect: 'write', code: 'CONFIRMATION_REQUIRED', confirmation },
      ],
      createdAt: new Date(now - 60_000).toISOString(),
      live: true,
      usage: { inputTokens: 5120, outputTokens: 412, totalTokens: 5532, cacheReadTokens: 2048, costUsd: null, costBasis: 'unknown' },
    },
  ]
  return {
    messages,
    status: 'idle',
    streamingContent: '',
    activeToolCalls: [],
    send: () => {},
    stop: () => {},
    reset: () => {},
    loadHistory: () => {},
    controls: { status: 'idle', confirmations: { [confirmation.code]: { phase: 'pending' } }, confirm: () => true, dismissConfirmation: () => {}, retry: () => {} },
    sessionUsage: null,
  }
}

const snapshots = []

async function capture(name, width, height, node, settle) {
  let utils
  await act(async () => {
    utils = render(node)
  })
  if (settle) await settle(utils)
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50))
  })
  snapshots.push({ name, width, height, html: document.body.innerHTML })
}

describe.skipIf(!LABEL)('token screenshots', () => {
  beforeAll(() => {
    mkdirSync(WORK_DIR, { recursive: true })
    Element.prototype.scrollIntoView ??= function scrollIntoView() {}
    Element.prototype.scrollTo ??= function scrollTo() {}
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  })
  afterEach(() => cleanup())

  it('board', async () => {
    fixture.tasks = boardTasks()
    const { KanbanBoard } = await import('@/components/board/kanban-board')
    await capture('board', 1280, 760, h('div', { className: 'flex h-screen flex-col bg-linear-bg' }, h(KanbanBoard, { projectId: 'p1', projects: [] })))
  })

  it('detail', async () => {
    const { installViewport, restoreViewport } = await import('@/components/execution/test-helpers.mjs')
    const store = await import('@/lib/execution-state-store')
    const { legacySuccessRun, legacyHistory } = await import('@/lib/run-model/fixtures.mjs')
    const { TaskDetailView } = await import('@/components/task-detail-view')
    installViewport(420, 560)
    const task = makeTask(12, {
      title: 'Fix the login redirect loop',
      description: 'Users are bounced between /login and /board after the token refresh.',
      priority: 'high',
      status: 'in_progress',
      executionStartedAt: '2026-10-25T10:00:00.000Z',
      executionProgress: 40,
      labels: [LABELS.bug],
    })
    const events = legacySuccessRun().map(([type, data, meta]) => [type, { ...data, taskId: task.id }, meta])
    for (const entry of legacyHistory(events).slice(0, 16)) store.appendExecutionLog(task.id, entry)
    store.setExecutionProgress({ taskId: task.id, status: 'executing', message: 'Running: Run unit tests' })
    try {
      await capture('detail', 1280, 800, h(TaskDetailView, { open: true, onClose: () => {}, task, isExecuting: true, onCancel: async () => true }))
    } finally {
      restoreViewport()
    }
  })

  it('chat', async () => {
    fixture.chat = chatFixture()
    const { ChatPanel } = await import('@/components/chat/chat-panel')
    await capture('chat', 760, 820, h('div', { className: 'flex h-screen flex-col' }, h(ChatPanel, {})))
  })

  it('settings', async () => {
    const { default: SettingsPage } = await import('@/app/(app)/settings/page')
    await capture('settings', 1280, 800, h('div', { className: 'flex h-screen flex-col bg-linear-bg' }, h(SettingsPage)), async () => {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 100))
      })
    })
  })

  it('specimen', async () => {
    const { TokenSpecimen } = await import('./token-specimen.capture.mjs')
    await capture('specimen', 1180, 900, h(TokenSpecimen))
  })

  it('writes the screenshots', async () => {
    const css = await buildCss()
    for (const shot of snapshots) {
      const htmlPath = join(WORK_DIR, `${shot.name}.html`)
      writeFileSync(htmlPath, page(shot, css))
      const pngPath = join(OUT_DIR, `tokens-${shot.name}-${LABEL}.png`)
      await screenshot(htmlPath, pngPath, shot.width, shot.height)
      await shrink(pngPath)
    }
  }, 120_000)
})

function page(shot, css) {
  return `<!doctype html><html lang="en" class="dark" data-openlinear-render-profile="default"><head><meta charset="utf-8">
<style>${css}</style>
<style>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>
</head><body style="width:${shot.width}px;height:${shot.height}px;overflow:hidden">${shot.html}</body></html>`
}

async function buildCss() {
  const { default: postcss } = await import('postcss')
  const { default: tailwindcss } = await import('tailwindcss')
  const fonts = pathToFileURL(join(PKG, 'public/fonts')).href
  const source = readFileSync(join(PKG, 'app/globals.css'), 'utf8').replaceAll("url('/fonts/", `url('${fonts}/`)
  const result = await postcss([tailwindcss(join(PKG, 'tailwind.config.ts'))]).process(source, { from: join(PKG, 'app/globals.css') })
  return result.css
}

function chromiumPath() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('No Chrome/Chromium found; set CHROMIUM_BIN')
  return found
}

function screenshot(htmlPath, pngPath, width, height) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--force-device-scale-factor=1',
    '--allow-file-access-from-files',
    `--user-data-dir=${join(WORK_DIR, 'profile')}`,
    `--window-size=${width},${height}`,
    '--virtual-time-budget=3000',
    `--screenshot=${pngPath}`,
    pathToFileURL(htmlPath).href,
  ]
  return new Promise((done, fail) => {
    const child = spawn(chromiumPath(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', fail)
    child.on('exit', (code) => {
      if (code === 0 && existsSync(pngPath)) done()
      else fail(new Error(`Chrome exited with ${code}: ${stderr.slice(-2000)}`))
    })
  })
}

async function shrink(pngPath) {
  if (statSync(pngPath).size <= MAX_PNG_BYTES) return
  const { default: sharp } = await import(pathToFileURL(resolve(PKG, '../../node_modules/sharp/lib/index.js')).href)
  const buffer = await sharp(pngPath).png({ palette: true, quality: 90, compressionLevel: 9 }).toBuffer()
  writeFileSync(pngPath, buffer)
}
