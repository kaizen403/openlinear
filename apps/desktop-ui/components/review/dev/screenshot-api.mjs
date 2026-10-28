// Screenshot harness stand-in for `@/lib/api/review` (aliased by screenshots.mjs).
// Serves fixture payloads per `window.__REVIEW_SCENARIO`; never touches a network.
import { ApiError } from '@/lib/api/fetch'
import { sampleDiff } from '../fixtures.mjs'

const scenario = () => (typeof window !== 'undefined' && window.__REVIEW_SCENARIO) || 'unified'

export async function fetchTaskDiff() {
  const diff = sampleDiff()
  if (scenario() === 'split') return { ...diff, head: { ...diff.head, dirty: false } }
  if (scenario() === 'states') return { ...diff, revision: 'rev-states', head: { ...diff.head, dirty: true } }
  return diff
}

export async function fetchTaskRunState() {
  if (scenario() === 'split') {
    return {
      run: {
        runId: 'run-1',
        state: 'succeeded',
        attemptId: 'att-1',
        lastSeq: 42,
        relayAckSeq: 42,
        terminal: { state: 'succeeded', reason: 'Pull request created', outcome: null, prUrl: 'https://github.com/acme/api/pull/128', claimed: true },
        effects: [
          { key: 'run-1:git.commit', kind: 'git.commit', status: 'confirmed' },
          { key: 'run-1:git.push', kind: 'git.push', status: 'confirmed' },
          { key: 'run-1:pr.create', kind: 'pr.create', status: 'confirmed' },
        ],
        verification: {
          status: 'passed',
          commit: 'f00dbabe',
          checks: [
            { name: 'pnpm typecheck', status: 'passed' },
            { name: 'pnpm test (api)', status: 'passed', summary: '601 passed' },
            { name: 'biome lint', status: 'passed' },
          ],
        },
      },
    }
  }
  throw new ApiError(404, 'No v2 run is recorded for this task on this device', 'RUN_NOT_FOUND')
}

export async function sendTaskFollowUp() {
  throw new ApiError(404, 'Request failed with status 404')
}
