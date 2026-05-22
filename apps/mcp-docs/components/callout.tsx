import { AlertTriangle, Info, Lightbulb, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/cn'

type Variant = 'info' | 'warning' | 'tip' | 'success'

const styles: Record<Variant, { icon: React.ComponentType<{ className?: string }>; cls: string; iconCls: string }> = {
  info: { icon: Info, cls: 'border-sky-500/20 bg-sky-500/[0.04]', iconCls: 'text-sky-400' },
  warning: { icon: AlertTriangle, cls: 'border-amber-500/20 bg-amber-500/[0.04]', iconCls: 'text-amber-400' },
  tip: { icon: Lightbulb, cls: 'border-violet-500/20 bg-violet-500/[0.04]', iconCls: 'text-violet-400' },
  success: { icon: CheckCircle2, cls: 'border-emerald-500/20 bg-emerald-500/[0.04]', iconCls: 'text-emerald-400' },
}

export function Callout({
  variant = 'info',
  title,
  children,
}: {
  variant?: Variant
  title?: string
  children: React.ReactNode
}) {
  const { icon: Icon, cls, iconCls } = styles[variant]
  return (
    <div className={cn('my-5 flex gap-3 rounded-lg border px-4 py-3.5', cls)}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', iconCls)} />
      <div className="text-sm text-foreground/90 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">
        {title && <div className="mb-1 font-medium text-white">{title}</div>}
        {children}
      </div>
    </div>
  )
}
