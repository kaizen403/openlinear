# Root Cause: Model Name Truncation

## The Real Problem

**File**: `apps/desktop-ui/components/ui/select.tsx` (line 22)

The base `SelectTrigger` component has this hardcoded:

```tsx
className={cn(
  "flex h-8 w-full items-center justify-between rounded-sm border border-input bg-transparent px-2.5 py-1.5 text-sm data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1",
  className
)}
```

`[&>span]:line-clamp-1` applies `-webkit-line-clamp: 1` + `text-overflow: ellipsis` to **every child `<span>`** inside the trigger.

## Why Overrides Fail

Both these files try to override with `!important`:

**model-selector.tsx**:
```tsx
"[&>span]:!block [&>span]:!overflow-visible [&>span]:!whitespace-nowrap [&>span]:!text-clip [&>span]:!line-clamp-none"
```

**ai-providers-section.tsx**:
```tsx
"[&>span]:!block [&>span]:!overflow-visible [&>span]:!whitespace-nowrap [&>span]:!text-clip [&>span]:!line-clamp-none"
```

But `line-clamp-1` from the base component may be winning due to:
1. Tailwind CSS ordering (base styles loaded after overrides)
2. The `cn()` utility merging order
3. Radix UI's internal wrapper elements not matching `[&>span]`

## The Fix

**Option 1 (Cleanest)**: Remove `[&>span]:line-clamp-1` from the base component:

```tsx
// apps/desktop-ui/components/ui/select.tsx
// Line 22 - REMOVE: [&>span]:line-clamp-1
className={cn(
  "flex h-8 w-full items-center justify-between rounded-sm border border-input bg-transparent px-2.5 py-1.5 text-sm data-[placeholder]:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
  className
)}
```

Then add `truncate` or `line-clamp-1` back to specific Select instances that need it via their `className` prop.

**Option 2 (Surgical)**: If removing from base breaks other selects, target the specific element in model-selector.tsx:

The `SelectValue` renders as a `<span>` inside Radix's trigger. The overrides on `SelectTrigger` should work, but if they don't, try targeting `.radix-select-trigger > span` in global CSS, or wrap the text in a div instead:

```tsx
<SelectValue placeholder="Select Model">
  <div className="flex items-center gap-2 whitespace-nowrap overflow-visible">
    <span>{selectedModelObj?.name}</span>
    {selectedModelObj?.reasoning && <span>reasoning</span>}
  </div>
</SelectValue>
```

**Option 3 (Nuclear)**: Override the CSS globally in your Tailwind config or CSS module:

```css
[data-radix-select-trigger] > span {
  -webkit-line-clamp: unset !important;
  text-overflow: clip !important;
  overflow: visible !important;
  white-space: nowrap !important;
}
```

## Verification

After any fix, run:
```bash
cd apps/desktop-ui && pnpm dev
```

Check DevTools → Elements → inspect the trigger. The `<span>` containing "Claude Opus 4.6" should NOT have:
- `-webkit-line-clamp: 1`
- `text-overflow: ellipsis`

It SHOULD have:
- `white-space: nowrap`
- `overflow: visible` (or `overflow: hidden` with `text-overflow: clip`)

## Files to Change

| File | Change |
|------|--------|
| `components/ui/select.tsx` | Remove `[&>span]:line-clamp-1` from SelectTrigger |
| `components/board/model-selector.tsx` | Ensure `whitespace-nowrap` on SelectValue content |
| `components/settings/ai-providers-section.tsx` | Verify same fix applies |

## Current State (Broken)

```
┌─ SelectTrigger ───────────────────────────┐
│  [span] line-clamp-1 ← forces ...         │
│     "Claude Op..." + "reasoning" + chevron │
└───────────────────────────────────────────┘
```

## Desired State (Fixed)

```
┌─ SelectTrigger ───────────────────────────┐
│  [div] flex whitespace-nowrap             │
│     "Claude Opus 4.6" + "reasoning" + ▼   │
└───────────────────────────────────────────┘
```
