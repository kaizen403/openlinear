# Issue Plan: Onboarding Timeline Redesign

## Current Problem
The onboarding step indicator uses a slider-style horizontal scroll layout (`overflow-x-auto`) with small bordered pills connected by thin lines. This feels cramped, generic, and doesn't reflect the OpenLinear brand identity.

**Screenshot:** The current timeline appears as a scrollable row of tiny boxes: `[✓ Welcome] — [✓ Connect repo] — [✓ Pick branch] — [4 Set up team] — [5 Invite] — [6 Cre...]` with a scrollbar visible.

## Design Direction
Replace with a **proper branded timeline** that feels premium, non-scrolling, and visually communicates progress clearly.

### Design System Reference
- Background: `#111111`
- Card/panel bg: `#141414`
- Accent: `#1d4ed8` (runtime themable via `--linear-accent`)
- Text primary: `#f5f5f5`
- Text secondary: `#a0a0a0`
- Text tertiary: `#6a6a6a`
- Border: `#2a2a2a`
- Font: Anthropic Sans (300-800)
- Radius: `0.125rem` (2px) — sharp, minimal
- Animation: Framer Motion spring transitions (stiffness: 300, damping: 30)

### Proposed New Timeline Design

**Layout:** Centered horizontal non-scrolling timeline with 6 evenly spaced nodes.

**Visual Elements:**

1. **Nodes (circles)**
   - Size: 32px diameter
   - Completed: Filled with accent color `#1d4ed8`, white checkmark icon, subtle shadow `0 0 12px var(--linear-accent)/40%`
   - Active: Filled with accent color, white number, **pulsing glow ring** (animated `box-shadow` or ring scale)
   - Upcoming: Outlined with `#2a2a2a` border, `#6a6a6a` number/text

2. **Connecting Lines**
   - Height: 2px
   - Completed segments: Solid accent color with subtle gradient glow
   - Upcoming segments: `#2a2a2a`
   - **Animated fill**: When a step completes, the line to the next node fills with accent color (width animation 0% → 100%)

3. **Step Labels**
   - Position: Below each node
   - Completed: `text-xs text-linear-text-secondary`
   - Active: `text-xs font-medium text-linear-text`
   - Upcoming: `text-xs text-linear-text-tertiary`
   - No truncation — layout ensures all 6 labels fit without scroll

4. **Responsive Behavior**
   - Desktop (>768px): Full horizontal timeline with labels below
   - Tablet/Mobile: Nodes only (32px), labels hidden or shown as tooltip on hover/active

5. **Animations**
   - Node completion: Scale bounce (0.9 → 1.05 → 1) + checkmark fade-in
   - Active transition: Glow ring pulses (2s ease-in-out infinite)
   - Line fill: Width expands from left with spring transition
   - Label transition: Opacity + translateY(-4px → 0)

### Why This Is Better
- **No scrollbar** — all 6 steps visible at once, no overflow-x
- **Clear hierarchy** — active step glows, completed steps glow faintly, upcoming steps recede
- **Brand-aligned** — uses the exact color palette, radius, font, and animation language already in the app
- **Motion tells story** — the filling line and pulsing active node communicate "you are here" without reading

## Files to Modify
- `apps/desktop-ui/components/onboarding/onboarding-wizard.tsx` — Replace `StepIndicator` component (lines 1381-1458)

## Acceptance Criteria
- [x] Step indicator is non-scrolling and shows all 6 steps fully
- [x] Active step has a visible glow/pulse effect
- [x] Completed steps show a checkmark with accent fill
- [x] Connecting line segments animate fill on step change
- [x] Labels are readable and don't truncate
- [x] Respects `useReducedMotion()` — disables animations when user prefers reduced motion
- [x] Matches existing color tokens (`linear-*` Tailwind classes)

## Effort Estimate
Small — single component replacement, ~80-120 lines, no backend changes.

## Status
**Implemented** — `StepIndicator` component replaced in `onboarding-wizard.tsx`. The new timeline uses:
- Absolute-positioned background track + animated `motion.div` fill bar
- 6 flex-spaced node columns with circular nodes
- Pulsing ring animation on active step via `motion.span` with infinite scale/opacity loop
- Spring transitions for all state changes
- `useReducedMotion()` gating on all animations
