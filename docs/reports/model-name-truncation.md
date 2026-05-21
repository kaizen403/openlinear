# Model Name Truncation Bug Report

## Problem

Model names in the kanban board selector are truncated with ellipsis (`...`), e.g. `Claude Op...` instead of `Claude Opus 4.6`.

**Location**: `apps/desktop-ui/components/board/model-selector.tsx`
**Screenshot**: [Image 1] shows "Claude Op..." with "reasoning" badge

---

## Root Cause

The truncation comes from **two conflicting CSS rules**:

### 1. `SelectTrigger` base component (`components/ui/select.tsx`)

```tsx
<SelectPrimitive.Trigger
  className={cn(
    "... [&>span]:line-clamp-1",  // ← forces ellipsis after 1 line
    className
  )}
>
```

The `[&>span]:line-clamp-1` rule applies `display: -webkit-box`, `-webkit-line-clamp: 1`, and `text-overflow: ellipsis` to ALL child `<span>` elements — including the one holding the model name.

### 2. Parent container width constraints

In `kanban-board.tsx`, the model selector sits inside a flex row with `divide-x` and snap points. Each info box has:

```tsx
className="flex-1 min-w-[132px] sm:min-w-0 px-2 py-1"
```

The `flex-1` makes all boxes share space equally. On smaller screens (or with many boxes), the model selector gets squeezed.

---

## Attempted Fixes

| Fix | File | Change | Result |
|-----|------|--------|--------|
| Increase min-width | `model-selector.tsx` | `min-w-[140px]` → `min-w-[340px]` | Partial — helps but `line-clamp-1` still cuts text |
| Remove `truncate` | `model-selector.tsx` | `truncate` → `whitespace-nowrap` | No effect — `line-clamp-1` overrides this |
| Override `line-clamp` | `model-selector.tsx` | Added `[&>span]:line-clamp-none` | Should work but **untested in live build** |

---

## Why Fixes Haven't Worked

1. **Hot reload limitation**: `pnpm dev` (Next.js + Turbopack) may not pick up nested component changes immediately. A full restart is needed.
2. **CSS specificity battle**: `line-clamp-1` is applied by the base `SelectTrigger` component. Overrides must have equal or higher specificity.
3. **Flex container squeeze**: Even with `min-w-[340px]`, the parent `flex-1` on sibling elements can still compress the selector's available width.

---

## Recommended Fix

### Option A: Override in model-selector (minimal change)

The `[&>span]:line-clamp-none` class was added to `SelectTrigger` — this should work if:
- Tailwind generates the CSS (check `.next/static/css/`)
- The selector has enough width (`min-w-[340px]` or `w-auto`)

### Option B: Fix the base component (proper fix)

In `apps/desktop-ui/components/ui/select.tsx`, remove `[&>span]:line-clamp-1` from `SelectTrigger`:

```tsx
// BEFORE
className={cn(
  "flex h-8 w-full items-center justify-between rounded-sm border border-input bg-transparent px-2.5 py-1.5 text-sm data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
  className
)}

// AFTER
className={cn(
  "flex h-8 w-full items-center justify-between rounded-sm border border-input bg-transparent px-2.5 py-1.5 text-sm data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
  className
)}
```

Then add truncation only where needed (other select components) via their own `className`.

### Option C: Restructure the kanban header

In `kanban-board.tsx`, give the model selector a fixed width instead of `flex-1`:

```tsx
// Change ModelSelector wrapper from:
<div className="flex items-center gap-2 px-3 py-1.5 min-w-[340px] shrink-0 snap-start">

// To:
<div className="flex items-center gap-2 px-3 py-1.5 w-[380px] shrink-0 snap-start">
```

Also remove `flex-1` from sibling info boxes or give them `max-w` constraints.

---

## Files Involved

| File | Role |
|------|------|
| `apps/desktop-ui/components/board/model-selector.tsx` | Displays model name + reasoning badge |
| `apps/desktop-ui/components/ui/select.tsx` | Base Select component with `line-clamp-1` |
| `apps/desktop-ui/components/board/kanban-board.tsx` | Parent flex container squeezing width |

---

## Test Checklist

- [ ] Run `pnpm dev` with **full restart** (not just hot reload)
- [ ] Select "Claude Opus 4.6" — should show full name, no `...`
- [ ] Check on 1280px and 1920px screen widths
- [ ] Verify other Select components (task form, provider selector) still truncate properly if needed
- [ ] Check `Elements` tab → the `<span>` inside SelectTrigger should NOT have `-webkit-line-clamp: 1`

## Reproduction

1. Open kanban board
2. Select any model with long name (e.g., "Claude Opus 4.6")
3. Observe truncated display in header bar

---

*Report generated: 2026-05-21*
