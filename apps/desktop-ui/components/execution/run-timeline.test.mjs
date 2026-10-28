import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup, within } from '@testing-library/react'
import { createElement } from 'react'

const { RunTimeline, timelineConsumesEscape } = await import('./run-timeline.tsx')
const { foldRunEvents } = await import('@/lib/run-model/model.ts')
const { decodeExecutionEvent } = await import('@/lib/run-model/decode.ts')
const { legacySuccessRun, chattyRun } = await import('@/lib/run-model/fixtures.mjs')
const { installViewport, restoreViewport, scrollAwayFromBottom, scrollToBottom } = await import('./test-helpers.mjs')

function snapshotOf(events, options) {
  return foldRunEvents(events.map(([type, data, meta]) => decodeExecutionEvent(type, data, meta, 0)), options)
}

function renderTimeline(props) {
  return render(createElement(RunTimeline, { entries: [], ...props }))
}

function articles() {
  return screen.getAllByRole('article')
}

beforeEach(() => installViewport(240))
afterEach(() => {
  cleanup()
  restoreViewport()
})

describe('RunTimeline', () => {
  it('renders the run as compact rows: tool calls, agent text without a bubble, file edits', () => {
    const snapshot = snapshotOf(legacySuccessRun())
    renderTimeline({ entries: snapshot.entries })

    const feed = screen.getByRole('feed', { name: 'Run timeline' })
    const bash = within(feed).getByRole('article', { name: /^Command Run unit tests, completed, 5\.1s/ })
    expect(bash.textContent).toContain('$ Run unit tests')
    expect(within(feed).getByRole('article', { name: /^Edit src\/auth\/login\.ts, completed/ })).toBeTruthy()
    expect(within(feed).getByRole('article', { name: 'Modified file src/auth/login.ts' })).toBeTruthy()
    const text = within(feed).getByRole('article', { name: /^Agent: The fix is in place/ })
    // Assistant text has no bubble: no fill, border or rounding around the paragraph.
    const paragraph = text.querySelector('p')
    expect(paragraph.className).not.toMatch(/\bbg-|\bborder\b|\brounded/)
    // The failed write is open by default with its error and a red rail.
    const failed = within(feed).getByRole('article', { name: /^Write src\/auth\/session\.ts, failed, 300ms, expanded/ })
    expect(failed.textContent).toContain('EACCES: permission denied')
  })

  it('keeps the DOM bounded for long runs (virtualized)', () => {
    const snapshot = snapshotOf(chattyRun(3_000), { maxEntries: 2_000 })
    expect(snapshot.entries.length).toBeGreaterThan(1_000)
    const { container } = renderTimeline({ entries: snapshot.entries, droppedEntries: snapshot.droppedEntries })
    const rendered = articles().length
    expect(rendered).toBeGreaterThan(5)
    expect(rendered).toBeLessThanOrEqual(40)
    expect(container.querySelectorAll('*').length).toBeLessThan(800)
  })

  it('moves through rows with j/k and the arrows; Enter expands, Escape collapses', () => {
    const snapshot = snapshotOf(legacySuccessRun())
    renderTimeline({ entries: snapshot.entries })
    // Exactly one tab stop: the newest row.
    const tabStops = articles().filter((article) => article.tabIndex === 0)
    expect(tabStops).toHaveLength(1)
    const last = tabStops[0]
    act(() => last.focus())

    fireEvent.keyDown(last, { key: 'k' })
    fireEvent.keyDown(document.activeElement, { key: 'k' })
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement, { key: 'j' })
    const focused = document.activeElement
    expect(focused.tagName).toBe('ARTICLE')
    expect(focused).not.toBe(last)
    // k, k, ↑, j from the newest row lands two rows above it.
    const labels = articles().map((article) => article.getAttribute('aria-label'))
    expect(labels.indexOf(focused.getAttribute('aria-label'))).toBe(labels.indexOf(last.getAttribute('aria-label')) - 2)

    // Walk up to the bash row and expand it.
    let guard = 0
    while (!/^Command Run unit tests/.test(document.activeElement.getAttribute('aria-label')) && guard++ < 40) {
      fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' })
    }
    const bash = document.activeElement
    expect(bash.getAttribute('aria-label')).toMatch(/collapsed$/)
    fireEvent.keyDown(bash, { key: 'Enter' })
    const expanded = screen.getByRole('article', { name: /^Command Run unit tests.*expanded$/ })
    expect(expanded.textContent).toContain('12 passed')

    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    expect(timelineConsumesEscape({ target: expanded })).toBe(true)
    act(() => { expanded.dispatchEvent(escapeEvent) })
    expect(escapeEvent.defaultPrevented).toBe(true)
    const collapsed = screen.getByRole('article', { name: /^Command Run unit tests.*collapsed$/ })
    expect(collapsed.textContent).not.toContain('12 passed')

    // Escape on a collapsed row is left for the surrounding sheet.
    const again = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    expect(timelineConsumesEscape({ target: collapsed })).toBe(false)
    act(() => { collapsed.dispatchEvent(again) })
    expect(again.defaultPrevented).toBe(false)
  })

  it('shows a sticky "Jump to live" when scrolled up, counts new rows, and returns to the edge', () => {
    const events = legacySuccessRun()
    const first = snapshotOf(events.slice(0, 20))
    const { rerender, container } = renderTimeline({ entries: first.entries, live: true })
    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull()

    const scroller = container.querySelector('[data-run-timeline-scroller]')
    scrollAwayFromBottom(scroller)
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: /Jump to live/ })).toBeTruthy()

    const more = snapshotOf(events)
    rerender(createElement(RunTimeline, { entries: more.entries, live: true }))
    expect(screen.getByRole('button', { name: /Jump to live, \d+ new/ })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Jump to live/ }))
    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull()

    // Reaching the bottom by scrolling also hides it.
    scrollAwayFromBottom(scroller)
    fireEvent.scroll(scroller)
    expect(screen.getByRole('button', { name: /Jump to live/ })).toBeTruthy()
    scrollToBottom(scroller)
    fireEvent.scroll(scroller)
    expect(screen.queryByRole('button', { name: /Jump to/ })).toBeNull()
  })

  it('announces notable rows through a polite live region and marks dropped history', () => {
    const snapshot = snapshotOf(chattyRun(800), { maxEntries: 300 })
    renderTimeline({ entries: snapshot.entries, droppedEntries: snapshot.droppedEntries })
    const regions = screen.getAllByRole('status')
    expect(regions.some((region) => region.getAttribute('aria-live') === 'polite')).toBe(true)
    // The marker row is the first row; reach it with Home.
    const stop = articles().find((article) => article.tabIndex === 0)
    act(() => stop.focus())
    fireEvent.keyDown(stop, { key: 'Home' })
    expect(document.activeElement.textContent).toMatch(/earlier entries are not shown/)
  })

  it('renders the empty state when there are no entries', () => {
    renderTimeline({ entries: [], empty: createElement('p', null, 'Nothing yet') })
    expect(screen.getByText('Nothing yet')).toBeTruthy()
    expect(screen.queryByRole('feed')).toBeNull()
  })
})
