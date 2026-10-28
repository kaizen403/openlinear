// Fixture app for the review-panel screenshots (bundled by screenshots.mjs).
// Real components + the app's Tailwind build; API and SSE are fixture stand-ins.
import { createRoot } from 'react-dom/client'
import { TaskReviewPanel } from '../review-panel'
import { draftStorageKey } from '../model/drafts'
import { memoryStorage } from '../fixtures.mjs'

const scenario = window.__REVIEW_SCENARIO || 'unified'
const TASK_ID = 'kt-12-task'
const AUTH = 'apps/api/src/routes/auth.ts'

const drafts = {
  v: 1,
  message: scenario === 'states' ? 'Keep the old cookie path for one release.' : 'Also cover token reuse with a test.',
  comments: [
    { id: 'c1', path: AUTH, line: 13, side: 'new', body: 'Look the family up once per request — this runs on every refresh.', revision: 'rev-1', excerpt: '    const family = await deps.sessions.family(req.cookies.rt)', createdAt: 1, updatedAt: 1 },
    { id: 'c2', path: 'apps/api/src/services/rate-limit.ts', line: 4, side: 'new', body: 'Key the limiter by user id when the session is known.', revision: 'rev-1', excerpt: 'export const rateLimit', createdAt: 2, updatedAt: 2 },
  ],
}
const storage = memoryStorage({
  [draftStorageKey(TASK_ID)]: JSON.stringify(scenario === 'split' ? { v: 1, message: '', comments: [] } : drafts),
  'openlinear:review-view-mode': scenario === 'split' ? 'split' : 'unified',
})

const task = {
  id: TASK_ID,
  status: 'done',
  outcome: '3 files changed, 5 tools executed',
  prUrl: scenario === 'split' ? 'https://github.com/acme/api/pull/128' : 'https://github.com/acme/api/compare/main...openlinear/kt-12',
  batchId: null,
}

createRoot(document.getElementById('root')).render(
  <TaskReviewPanel task={task} phase="succeeded" storage={storage} onOpenUrl={() => {}} />,
)

function whenReady(selector, then, tries = 80) {
  const element = document.querySelector(selector)
  if (element) then(element)
  else if (tries > 0) setTimeout(() => whenReady(selector, then, tries - 1), 25)
}

if (scenario === 'unified') {
  // Open the comment editor on a line, the way a reviewer presses `c`.
  whenReady(`[data-row-key="l:${AUTH}:0:7"]`, (row) => {
    row.focus()
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
  })
}

if (scenario === 'states') {
  whenReady('input[type="checkbox"]', (checkbox) => {
    checkbox.click()
    whenReady('button[aria-describedby], button', () => {
      const send = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Send to agent'))
      send?.click()
    })
  })
}
