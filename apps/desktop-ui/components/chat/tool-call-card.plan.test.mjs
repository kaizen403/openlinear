import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { createElement } from 'react'

const { ToolCallCard, planReviewHref, knowledgeReviewHref } = await import('./tool-call-card.tsx')

afterEach(() => cleanup())

const proposed = {
  id: 'call-1',
  name: 'propose_plan',
  arguments: '{}',
  status: 'completed',
  effect: 'write',
  result: JSON.stringify({ planId: 'plan-1', projectId: 'p 1', title: 'Login', revision: 1, order: ['api'], warnings: [] }, null, 2),
}

describe('propose_plan in Home Chat (W17b)', () => {
  it('links a proposed plan to its review page', () => {
    expect(planReviewHref(proposed)).toBe('/projects/plans?id=p%201&plan=plan-1')
    expect(planReviewHref({ ...proposed, status: 'error' })).toBeNull()
    expect(planReviewHref({ ...proposed, name: 'create_issue' })).toBeNull()
    expect(planReviewHref({ ...proposed, result: 'not json' })).toBeNull()
    render(createElement(ToolCallCard, { toolCall: proposed }))
    const link = screen.getByRole('link', { name: /Review the plan/ })
    expect(link.getAttribute('href')).toBe('/projects/plans?id=p%201&plan=plan-1')
  })
})

describe('propose_knowledge in Home Chat (W19b)', () => {
  it('links a proposal to the project\'s Knowledge page', () => {
    const call = { ...proposed, id: 'call-2', name: 'propose_knowledge', result: JSON.stringify({ id: 'k1', projectId: 'p 1', status: 'proposed', title: 'Use pnpm' }) }
    expect(knowledgeReviewHref(call)).toBe('/projects/knowledge?id=p%201')
    expect(knowledgeReviewHref({ ...call, status: 'error' })).toBeNull()
    expect(knowledgeReviewHref(proposed)).toBeNull()
    render(createElement(ToolCallCard, { toolCall: call }))
    expect(screen.getByRole('link', { name: /Review the proposal/ }).getAttribute('href')).toBe('/projects/knowledge?id=p%201')
  })
})
