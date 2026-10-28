// The notification shapes live with their query (lib/query/notifications.ts).
export type {
  AppNotification,
  NotificationActor,
  NotificationsListResponse,
  NotificationType,
} from "@/lib/query/notifications"
import type { NotificationType } from "@/lib/query/notifications"

export type FilterChip = 'all' | 'mention' | 'assignment' | 'status_change'

export type Bucket = 'today' | 'week' | 'older'

const MS_DAY = 24 * 60 * 60 * 1000

export function startOfDay(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

export function bucketFor(dateStr: string, now: number): Bucket {
  const t = new Date(dateStr).getTime()
  const todayStart = startOfDay(new Date(now))
  if (t >= todayStart) return 'today'
  if (t >= todayStart - 6 * MS_DAY) return 'week'
  return 'older'
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  today: 'Today',
  week: 'This week',
  older: 'Older',
}

export const BUCKET_ORDER: Bucket[] = ['today', 'week', 'older']

const relativeFmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

export function timeAgo(dateStr: string, now: number): string {
  const diffSec = Math.round((new Date(dateStr).getTime() - now) / 1000)
  const abs = Math.abs(diffSec)
  if (abs < 60) return relativeFmt.format(diffSec, 'second')
  if (abs < 3600) return relativeFmt.format(Math.round(diffSec / 60), 'minute')
  if (abs < 86_400) return relativeFmt.format(Math.round(diffSec / 3600), 'hour')
  if (abs < 7 * 86_400) return relativeFmt.format(Math.round(diffSec / 86_400), 'day')
  if (abs < 30 * 86_400) return relativeFmt.format(Math.round(diffSec / (7 * 86_400)), 'week')
  return new Date(dateStr).toLocaleDateString()
}

export const TYPE_META: Record<NotificationType, {
  label: string
  color: string
  bg: string
}> = {
  mention: {
    label: '@mention',
    color: 'text-warning',
    bg: 'bg-warning/10',
  },
  assignment: {
    label: 'Assigned',
    color: 'text-linear-accent',
    bg: 'bg-linear-accent/10',
  },
  status_change: {
    label: 'Status',
    color: 'text-discovery',
    bg: 'bg-discovery/10',
  },
  comment: {
    label: 'Comment',
    color: 'text-success',
    bg: 'bg-success/10',
  },
}

export const FILTER_CHIPS: { id: FilterChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mention', label: '@mentions' },
  { id: 'assignment', label: 'Assignments' },
  { id: 'status_change', label: 'Status changes' },
]
