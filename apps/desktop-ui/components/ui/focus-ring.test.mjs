// Keyboard focus audit for every components/ui primitive (WCAG 2.4.7).
//
// Each primitive is rendered (opened where it has an overlay) and every
// element that can take keyboard focus must carry the shared focus-visible
// ring from components/ui/focus-ring.ts. Primitives with nothing focusable
// must render nothing focusable. A source check keeps new primitives and
// hand-written ring classes from slipping in.
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { createElement as h, useState } from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { useForm } from 'react-hook-form'

beforeAll(() => {
  // jsdom lacks these; Radix calls them.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  Element.prototype.scrollIntoView ??= vi.fn()
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
})
afterEach(() => cleanup())

const { focusRing, focusRingInset } = await import('./focus-ring.ts')
const ui = {
  ...(await import('./alert-dialog.tsx')),
  ...(await import('./assignee-picker.tsx')),
  ...(await import('./avatar.tsx')),
  ...(await import('./badge.tsx')),
  ...(await import('./button.tsx')),
  ...(await import('./card.tsx')),
  ...(await import('./checkbox.tsx')),
  ...(await import('./command.tsx')),
  ...(await import('./context-menu.tsx')),
  ...(await import('./date-picker.tsx')),
  ...(await import('./dialog.tsx')),
  ...(await import('./dropdown-menu.tsx')),
  ...(await import('./form.tsx')),
  ...(await import('./input.tsx')),
  ...(await import('./label.tsx')),
  ...(await import('./popover.tsx')),
  ...(await import('./scroll-area.tsx')),
  ...(await import('./select.tsx')),
  ...(await import('./sheet.tsx')),
  ...(await import('./skeleton.tsx')),
  ...(await import('./slider.tsx')),
  ...(await import('./switch.tsx')),
  ...(await import('./tabs.tsx')),
  ...(await import('./textarea.tsx')),
  ...(await import('./tooltip.tsx')),
}

const RING = ['focus-visible:ring-2', 'focus-visible:ring-ring']

// Elements that take keyboard focus: natively, via tabindex ≥ 0, or by roving
// focus inside Radix menus/listboxes/tablists. cmdk items are excluded on
// purpose: focus stays in the command input (selection is shown by background).
const FOCUSABLE = [
  'button', '[href]', 'input:not([type="hidden"])', 'select', 'textarea', '[tabindex]',
  '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]', '[role="option"]', '[role="tab"]',
].join(', ')
const ROVING = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"]'

function focusables() {
  return [...document.body.querySelectorAll(FOCUSABLE)].filter((element) => {
    if (element.hasAttribute('data-radix-focus-guard')) return false
    // A Radix roving-focus root (tablist) forwards focus to its active item on focus.
    if (element.matches('[role="tablist"]')) return false
    if (element.closest('[aria-hidden="true"]') || element.hasAttribute('cmdk-item')) return false
    if (element.getAttribute('tabindex') === '-1' && !element.matches(ROVING)) return false
    return !element.disabled
  })
}

function expectRing(element, label) {
  for (const token of RING) expect(element.className, `${label}: ${element.outerHTML.slice(0, 120)}`).toContain(token)
}

function FormHarness() {
  const form = useForm({ defaultValues: { name: '' } })
  return h(ui.Form, form, h('form', null, h(ui.FormField, {
    control: form.control,
    name: 'name',
    render: ({ field }) => h(ui.FormItem, null,
      h(ui.FormLabel, null, 'Name'),
      h(ui.FormControl, null, h(ui.Input, field)),
      h(ui.FormDescription, null, 'Shown on your profile'),
      h(ui.FormMessage)),
  })))
}

function Controlled({ children }) {
  const [value, setValue] = useState(null)
  return children(value, setValue)
}

/** file → { render, open?, minFocusable } ; minFocusable 0 means "renders nothing focusable". */
const CASES = {
  'alert-dialog': {
    render: () => h(ui.AlertDialog, { open: true }, h(ui.AlertDialogContent, null,
      h(ui.AlertDialogTitle, null, 'Delete?'), h(ui.AlertDialogDescription, null, 'Gone for good.'),
      h(ui.AlertDialogFooter, null, h(ui.AlertDialogCancel, null, 'Cancel'), h(ui.AlertDialogAction, null, 'Delete')))),
    minFocusable: 2,
  },
  'assignee-picker': {
    render: () => h(ui.AssigneePicker, { value: [], onChange: () => {}, members: [{ id: 'u1', username: 'ada' }], currentUserId: 'u1' }),
    open: () => fireEvent.click(document.body.querySelector('button')),
    minFocusable: 2, // trigger + search input
  },
  avatar: { render: () => h(ui.Avatar, null, h(ui.AvatarImage, { src: '', alt: '' }), h(ui.AvatarFallback, null, 'AL')), minFocusable: 0 },
  badge: { render: () => h(ui.Badge, null, 'New'), minFocusable: 0, alsoRing: () => document.body.querySelector('div > div') },
  button: { render: () => h(ui.Button, null, 'Save'), minFocusable: 1 },
  card: {
    render: () => h(ui.Card, null, h(ui.CardHeader, null, h(ui.CardTitle, null, 'T'), h(ui.CardDescription, null, 'D')), h(ui.CardContent, null, 'C'), h(ui.CardFooter, null, 'F')),
    minFocusable: 0,
  },
  checkbox: { render: () => h(ui.Checkbox, { 'aria-label': 'Done' }), minFocusable: 1 },
  command: {
    render: () => h(ui.Command, null, h(ui.CommandInput, { placeholder: 'Search' }), h(ui.CommandList, null,
      h(ui.CommandEmpty, null, 'None'), h(ui.CommandGroup, { heading: 'G' }, h(ui.CommandItem, null, 'One'), h(ui.CommandSeparator), h(ui.CommandItem, null, 'Two', h(ui.CommandShortcut, null, '⌘K'))))),
    minFocusable: 1,
  },
  'context-menu': {
    render: () => h(ui.ContextMenu, null,
      h(ui.ContextMenuTrigger, { asChild: true }, h(ui.Button, null, 'Right-click me')),
      h(ui.ContextMenuContent, null,
        h(ui.ContextMenuLabel, null, 'Label'), h(ui.ContextMenuItem, null, 'Item'), h(ui.ContextMenuSeparator),
        h(ui.ContextMenuCheckboxItem, { checked: true }, 'Check'),
        h(ui.ContextMenuRadioGroup, { value: 'a' }, h(ui.ContextMenuRadioItem, { value: 'a' }, 'Radio')),
        h(ui.ContextMenuSub, null, h(ui.ContextMenuSubTrigger, null, 'More'), h(ui.ContextMenuSubContent, null, h(ui.ContextMenuItem, null, 'Nested'))))),
    open: () => fireEvent.contextMenu(document.body.querySelector('button')),
    minFocusable: 4, // item, checkbox, radio, sub-trigger (the open menu hides the trigger from AT)
  },
  'date-picker': {
    render: () => h(Controlled, null, (value, setValue) => h(ui.DatePicker, { value, onChange: setValue })),
    open: () => fireEvent.click(document.body.querySelector('button')),
    minFocusable: 30, // trigger, month arrows, every day, Today
  },
  dialog: {
    render: () => h(ui.Dialog, { open: true }, h(ui.DialogContent, null, h(ui.DialogHeader, null, h(ui.DialogTitle, null, 'T'), h(ui.DialogDescription, null, 'D')), h(ui.DialogFooter, null, h(ui.DialogClose, { asChild: true }, h(ui.Button, null, 'Done'))))),
    minFocusable: 2,
  },
  'dropdown-menu': {
    render: () => h(ui.DropdownMenu, { open: true }, h(ui.DropdownMenuTrigger, { asChild: true }, h(ui.Button, null, 'Open')),
      h(ui.DropdownMenuContent, null,
        h(ui.DropdownMenuLabel, null, 'Label'), h(ui.DropdownMenuGroup, null, h(ui.DropdownMenuItem, null, 'Item', h(ui.DropdownMenuShortcut, null, '⌘I'))),
        h(ui.DropdownMenuSeparator), h(ui.DropdownMenuCheckboxItem, { checked: true }, 'Check'),
        h(ui.DropdownMenuRadioGroup, { value: 'a' }, h(ui.DropdownMenuRadioItem, { value: 'a' }, 'Radio')),
        h(ui.DropdownMenuSub, null, h(ui.DropdownMenuSubTrigger, null, 'More'), h(ui.DropdownMenuSubContent, null, h(ui.DropdownMenuItem, null, 'Nested'))))),
    minFocusable: 4,
  },
  form: { render: () => h(FormHarness), minFocusable: 1 },
  input: { render: () => h(ui.Input, { 'aria-label': 'Name' }), minFocusable: 1 },
  label: { render: () => h(ui.Label, null, 'Name'), minFocusable: 0 },
  popover: {
    render: () => h(ui.Popover, { open: true }, h(ui.PopoverTrigger, { asChild: true }, h(ui.Button, null, 'Open')), h(ui.PopoverContent, null, 'Nothing focusable inside')),
    minFocusable: 1,
    // The content itself takes focus when it holds nothing focusable.
    alsoRing: () => document.body.querySelector('[data-radix-popper-content-wrapper] > div'),
  },
  'scroll-area': {
    render: () => h(ui.ScrollArea, { className: 'h-10' }, h('p', null, 'Long text')),
    minFocusable: 0,
    // Browsers make scrollable regions keyboard-focusable.
    alsoRing: () => document.body.querySelector('[data-radix-scroll-area-viewport]'),
  },
  select: {
    render: () => h(ui.Select, { open: true, defaultValue: 'a' }, h(ui.SelectTrigger, { 'aria-label': 'Pick' }, h(ui.SelectValue, null)),
      h(ui.SelectContent, null, h(ui.SelectGroup, null, h(ui.SelectLabel, null, 'Group'), h(ui.SelectItem, { value: 'a' }, 'A'), h(ui.SelectSeparator), h(ui.SelectItem, { value: 'b' }, 'B')))),
    minFocusable: 2, // the options; the open listbox hides the trigger from AT
    alsoRing: () => document.body.querySelector('[role="combobox"]'),
  },
  sheet: {
    render: () => h(ui.Sheet, { open: true }, h(ui.SheetContent, null, h(ui.SheetHeader, null, h(ui.SheetTitle, null, 'T'), h(ui.SheetDescription, null, 'D')), h(ui.SheetFooter, null, h(ui.SheetClose, { asChild: true }, h(ui.Button, null, 'Done'))))),
    minFocusable: 2,
  },
  skeleton: { render: () => h(ui.Skeleton, { className: 'h-4 w-10' }), minFocusable: 0 },
  slider: { render: () => h(ui.Slider, { defaultValue: [50], max: 100, 'aria-label': 'Volume' }), minFocusable: 1 },
  switch: { render: () => h(ui.Switch, { 'aria-label': 'On' }), minFocusable: 1 },
  tabs: {
    render: () => h(ui.Tabs, { defaultValue: 'a' }, h(ui.TabsList, null, h(ui.TabsTrigger, { value: 'a' }, 'A'), h(ui.TabsTrigger, { value: 'b' }, 'B')), h(ui.TabsContent, { value: 'a' }, 'Panel A')),
    minFocusable: 3, // two tabs + the focusable panel
  },
  textarea: { render: () => h(ui.Textarea, { 'aria-label': 'Notes' }), minFocusable: 1 },
  tooltip: {
    render: () => h(ui.TooltipProvider, null, h(ui.Tooltip, { open: true }, h(ui.TooltipTrigger, { asChild: true }, h(ui.Button, null, 'Hover')), h(ui.TooltipContent, null, 'Hint'))),
    minFocusable: 1,
  },
}

describe('components/ui keyboard focus', () => {
  it('audits every primitive file', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    const files = readdirSync(dir).filter((file) => file.endsWith('.tsx')).map((file) => file.replace(/\.tsx$/, '')).sort()
    expect(files).toEqual(Object.keys(CASES).sort())
  })

  it('uses only the shared focus token (no hand-written ring classes)', () => {
    const dir = dirname(fileURLToPath(import.meta.url))
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.tsx'))) {
      expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/focus-visible:ring/)
    }
    for (const token of RING) {
      expect(focusRing).toContain(token)
      expect(focusRingInset).toContain(token)
    }
  })

  for (const [name, spec] of Object.entries(CASES)) {
    it(`${name}: every focusable element shows the focus-visible ring`, () => {
      render(spec.render())
      if (spec.open) act(() => spec.open())
      const elements = focusables()
      if (spec.minFocusable === 0) {
        expect(elements, name).toHaveLength(0)
      } else {
        expect(elements.length, name).toBeGreaterThanOrEqual(spec.minFocusable)
      }
      for (const element of elements) expectRing(element, name)
      if (spec.alsoRing) {
        const element = spec.alsoRing()
        expect(element, `${name} extra target`).toBeTruthy()
        expectRing(element, name)
      }
    })
  }
})
