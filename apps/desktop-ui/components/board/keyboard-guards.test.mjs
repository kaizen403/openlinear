import { describe, expect, it } from 'vitest'
import { isEditableTarget, isInsideOverlay } from './keyboard-guards'

// Regression coverage for T2: the board's global 'd'/Backspace delete
// shortcut must not fire while the user is typing in an input/textarea/
// contenteditable, or while focus is inside an open dialog/sheet/popover
// (even on a non-input element there, like a button) — see kanban-board.tsx's
// onKeyDown handler, which guards the delete branch with these two checks.

describe('isEditableTarget', () => {
  it('is true for an <input>', () => {
    const input = document.createElement('input')
    expect(isEditableTarget(input)).toBe(true)
  })

  it('is true for a <textarea>', () => {
    const textarea = document.createElement('textarea')
    expect(isEditableTarget(textarea)).toBe(true)
  })

  it('is true for a contentEditable element', () => {
    // jsdom doesn't implement the `contentEditable` property setter (it's a
    // silent no-op), so set the attribute directly — this is exactly the
    // fallback path isEditableTarget uses for DOM implementations like this.
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    expect(isEditableTarget(div)).toBe(true)
    div.remove()
  })

  it('is false for a plain button or null target', () => {
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('isInsideOverlay', () => {
  it('is true for an element inside role="dialog" (Dialog/Sheet)', () => {
    document.body.innerHTML = '<div role="dialog"><button id="btn">Close</button></div>'
    const btn = document.getElementById('btn')
    expect(isInsideOverlay(btn)).toBe(true)
  })

  it('is true for an element inside role="alertdialog" (AlertDialog)', () => {
    document.body.innerHTML = '<div role="alertdialog"><button id="confirm">Delete</button></div>'
    expect(isInsideOverlay(document.getElementById('confirm'))).toBe(true)
  })

  it('is true for an element inside a Radix popper wrapper (popover/dropdown/select/context-menu)', () => {
    document.body.innerHTML =
      '<div data-radix-popper-content-wrapper><div id="item">Item</div></div>'
    expect(isInsideOverlay(document.getElementById('item'))).toBe(true)
  })

  it('is false for an element on the board itself', () => {
    document.body.innerHTML = '<div id="card">Task card</div>'
    expect(isInsideOverlay(document.getElementById('card'))).toBe(false)
  })

  it('is false for a null target', () => {
    expect(isInsideOverlay(null)).toBe(false)
  })
})
