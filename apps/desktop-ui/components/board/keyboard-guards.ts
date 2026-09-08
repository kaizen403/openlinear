/**
 * Guards for the kanban board's global keyboard shortcuts (see kanban-board.tsx).
 * Extracted as pure, DOM-only helpers so they're unit-testable without mounting
 * the full board (which pulls in drag-and-drop, SSE, and data fetching).
 */

function asElement(target: EventTarget | null): HTMLElement | null {
  if (!target || typeof target !== "object") return null
  return "tagName" in target ? (target as HTMLElement) : null
}

/** True when the event target is a text-entry element — typing should never be hijacked. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = asElement(target)
  if (!el) return false
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return true
  if (el.isContentEditable) return true
  // Fall back to the raw attribute: some DOM implementations (notably jsdom,
  // used in tests) don't compute `isContentEditable` from `contentEditable`.
  const attr = typeof el.getAttribute === "function" ? el.getAttribute("contenteditable") : null
  return attr === "" || attr === "true"
}

/**
 * True when the event target sits inside an open Radix dialog/sheet/alert-dialog
 * (`role="dialog"` / `role="alertdialog"`) or a popper-based popover/dropdown/
 * select/context-menu (rendered inside a `[data-radix-popper-content-wrapper]`
 * portal). Board-level shortcuts should never fire while focus is inside one of
 * these — the overlay owns keyboard input at that point, even if the focused
 * element inside it isn't itself an input.
 */
export function isInsideOverlay(target: EventTarget | null): boolean {
  const el = asElement(target)
  if (!el || typeof el.closest !== "function") return false
  return !!el.closest('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]')
}
