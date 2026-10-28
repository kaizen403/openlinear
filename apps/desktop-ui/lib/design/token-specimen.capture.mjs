// Token specimen for the opt-in screenshot check (token-screenshots.capture.test.mjs).
// Uses only the class names and token maps components use, so the same file
// renders the before and after states.
import { createElement as h } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { STATUS_COLORS, PRIORITY_COLORS, BATCH_STATUS_COLORS } from '@/lib/design-tokens'
import { TONE_SURFACE, TONE_TEXT } from '@/components/execution/tokens'

const SURFACES = [
  ['html canvas', 'bg-background'],
  ['app (linear-bg)', 'bg-linear-bg'],
  ['raised (bg-secondary)', 'bg-linear-bg-secondary'],
  ['inset (bg-tertiary)', 'bg-linear-bg-tertiary'],
  ['card', 'bg-card'],
  ['popover', 'bg-popover'],
]

const TEXTS = [
  ['primary', 'text-linear-text'],
  ['foreground', 'text-foreground'],
  ['secondary', 'text-linear-text-secondary'],
  ['tertiary', 'text-linear-text-tertiary'],
  ['muted-fg', 'text-muted-foreground'],
  ['accent', 'text-linear-accent'],
  ['destructive', 'text-destructive'],
]

function Section(title, ...children) {
  return h('section', { className: 'space-y-2' },
    h('h2', { className: 'text-xs font-semibold uppercase tracking-wide text-linear-text-secondary' }, title),
    ...children)
}

function Chip(label, triad) {
  return h('span', { key: label, className: `inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs font-medium ${triad.bg} ${triad.border} ${triad.text}` },
    h('span', { className: `h-1.5 w-1.5 rounded-full ${triad.dot ?? triad.bg}` }),
    label)
}

export function TokenSpecimen() {
  return h('div', { className: 'min-h-screen bg-linear-bg p-6 text-linear-text' },
    h('div', { className: 'grid grid-cols-2 gap-6' },
      h('div', { className: 'space-y-5' },
        Section('Text on surfaces',
          h('div', { className: 'grid grid-cols-3 gap-2' },
            ...SURFACES.map(([name, bg]) => h('div', { key: name, className: `rounded-sm border border-linear-border p-2.5 ${bg}` },
              h('div', { className: 'mb-1.5 text-[11px] text-linear-text-secondary' }, name),
              ...TEXTS.map(([label, cls]) => h('div', { key: label, className: `text-xs leading-5 ${cls}` }, `${label} Aa 4.5:1`)))))),
        Section('Buttons',
          h('div', { className: 'flex flex-wrap items-center gap-2' },
            h(Button, {}, 'Execute'),
            h(Button, { variant: 'destructive' }, 'Delete'),
            h(Button, { variant: 'outline' }, 'Outline'),
            h(Button, { variant: 'secondary' }, 'Secondary'),
            h(Button, { variant: 'ghost' }, 'Ghost'),
            h(Button, { variant: 'link' }, 'Link'),
            h(Button, { disabled: true }, 'Disabled'),
            h(Button, { className: 'ring-2 ring-ring ring-offset-2 ring-offset-background' }, 'Focused'))),
        Section('Badges',
          h('div', { className: 'flex flex-wrap items-center gap-2' },
            h(Badge, {}, 'default'),
            h(Badge, { variant: 'secondary' }, 'secondary'),
            h(Badge, { variant: 'destructive' }, 'destructive'),
            h(Badge, { variant: 'outline' }, 'outline'))),
        Section('Controls',
          h('div', { className: 'grid grid-cols-2 gap-3' },
            h(Input, { placeholder: 'Placeholder text', readOnly: true }),
            h(Input, { defaultValue: 'Typed value', readOnly: true }),
            h(Textarea, { placeholder: 'Describe the task…', readOnly: true, className: 'col-span-2 min-h-[56px]' })),
          h('div', { className: 'flex items-center gap-4 pt-1 text-xs text-linear-text-secondary' },
            h('label', { className: 'flex items-center gap-2' }, h(Checkbox, {}), 'Unchecked'),
            h('label', { className: 'flex items-center gap-2' }, h(Checkbox, { defaultChecked: true }), 'Checked'),
            h('label', { className: 'flex items-center gap-2' }, h(Switch, {}), 'Off'),
            h('label', { className: 'flex items-center gap-2' }, h(Switch, { defaultChecked: true }), 'On'))),
        Section('Menu item highlight',
          h('div', { className: 'w-64 rounded-lg border bg-popover p-1 text-popover-foreground shadow-elevation' },
            h('div', { className: 'rounded-md px-2 py-1.5 text-sm' }, 'Assign to me'),
            h('div', { className: 'rounded-md bg-accent px-2 py-1.5 text-sm text-accent-foreground' }, 'Set priority (highlighted)'),
            h('div', { className: 'rounded-md px-2 py-1.5 text-sm text-destructive' }, 'Delete issue')))),
      h('div', { className: 'space-y-5' },
        Section('Task status (STATUS_COLORS)',
          h('div', { className: 'flex flex-wrap gap-2' }, ...Object.entries(STATUS_COLORS).map(([key, triad]) => Chip(key, triad)))),
        Section('Priority (PRIORITY_COLORS)',
          h('div', { className: 'flex flex-wrap gap-2' }, ...Object.entries(PRIORITY_COLORS).map(([key, triad]) => Chip(key, triad)))),
        Section('Batch status (BATCH_STATUS_COLORS)',
          h('div', { className: 'flex flex-wrap gap-2' }, ...Object.entries(BATCH_STATUS_COLORS).map(([key, entry]) =>
            h('span', { key, className: `inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs ${entry.text}` },
              h('span', { className: `h-1.5 w-6 rounded-full ${entry.dot ?? entry.bg}` }), key)))),
        Section('Run phase tones (execution kit)',
          h('div', { className: 'flex flex-wrap gap-2' }, ...Object.keys(TONE_TEXT).map((tone) =>
            h('span', { key: tone, className: `inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_SURFACE[tone]} ${TONE_TEXT[tone].className}` }, tone)))),
        Section('Selection and tints',
          h('div', { className: 'space-y-1.5' },
            h('div', { className: 'rounded-sm border border-linear-accent bg-linear-accent/10 px-3 py-2 text-sm' }, 'Selected card — ', h('span', { className: 'text-linear-text-tertiary' }, 'KT-12 · 2h ago')),
            h('div', { className: 'rounded-sm border border-linear-border bg-linear-bg-tertiary px-3 py-2 text-sm text-linear-text-secondary' }, 'Hover row (bg-tertiary)'),
            h('div', { className: 'rounded-sm border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive' }, 'Error banner — the push was rejected'),
            h('div', { className: 'flex items-center gap-2 pt-1' },
              h('div', { className: 'h-1.5 w-40 overflow-hidden rounded-full bg-linear-border' }, h('div', { className: 'h-full w-2/3 bg-linear-accent' })),
              h('span', { className: 'text-xs text-linear-text-tertiary' }, 'progress')))),
        Section('Borders',
          h('div', { className: 'grid grid-cols-3 gap-2 text-xs text-linear-text-secondary' },
            h('div', { className: 'rounded-sm border border-border p-2' }, 'border'),
            h('div', { className: 'rounded-sm border border-linear-border p-2' }, 'linear-border'),
            h('div', { className: 'rounded-sm border border-linear-border-hover p-2' }, 'border-hover'),
            h('div', { className: 'rounded-sm border border-input p-2' }, 'input'),
            h('div', { className: 'rounded-sm border border-linear-accent p-2' }, 'accent'),
            h('div', { className: 'rounded-sm border border-destructive p-2' }, 'destructive'))))))
}
