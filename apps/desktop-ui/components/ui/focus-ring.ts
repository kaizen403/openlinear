/**
 * The one keyboard-focus style for OpenLinear controls (WCAG 2.4.7 / 2.4.13).
 *
 * `--ring` is #e6e6e6 on the near-black surfaces (~15:1), drawn 2px wide and
 * only for `:focus-visible`, so a mouse click never paints a ring.
 *
 * - `focusRing`: standalone controls (buttons, inputs, switches, triggers).
 *   The 2px offset keeps the ring visible on filled controls.
 * - `focusRingInset`: items inside menus, lists, popovers and scroll areas,
 *   where an outset ring would be clipped by `overflow: hidden`.
 *
 * Primitives in components/ui must use one of these instead of hand-writing
 * ring classes (enforced by components/ui/focus-ring.test.mjs).
 */
export const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

export const focusRingInset = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
