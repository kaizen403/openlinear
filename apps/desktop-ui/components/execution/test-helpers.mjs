// Shared helpers for the execution kit's DOM tests (not a test file).
//
// jsdom has no layout: every element measures 0. The timeline's scroll
// container gets a fixed viewport height so the virtualizer computes a real
// window, and rows fall back to their size estimates (the timeline's
// measureElement keeps the estimate when an element measures 0).

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')

export function installViewport(height = 240, width = 400) {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return this.hasAttribute?.('data-run-timeline-scroller') ? height : 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return this.hasAttribute?.('data-run-timeline-scroller') ? width : 0
    },
  })
}

export function restoreViewport() {
  if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeight)
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth)
}

/** Pretend the reader scrolled `fromBottom` px above the end of the list. */
export function scrollAwayFromBottom(scroller, { scrollHeight = 5_000, clientHeight = 240, fromBottom = 600 } = {}) {
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: scrollHeight - clientHeight - fromBottom })
}

export function scrollToBottom(scroller, { scrollHeight = 5_000, clientHeight = 240 } = {}) {
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(scroller, 'scrollTop', { configurable: true, writable: true, value: scrollHeight - clientHeight })
}
