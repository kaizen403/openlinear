import { prisma } from '@openlinear/db';

const ALL_EVENT_TYPES = [
  'task_assigned',
  'task_status_changed',
  'task_commented',
  'mentioned',
  'invitation_received',
] as const;

export type NotificationEventType = (typeof ALL_EVENT_TYPES)[number];

export async function getPreferences(userId: string) {
  const existing = await prisma.notificationPreference.findMany({
    where: { userId },
  });

  if (existing.length > 0) return existing;

  // Create defaults
  const defaults = ALL_EVENT_TYPES.map((eventType) => ({
    userId,
    eventType,
    channel: 'in_app',
    enabled: true,
  }));

  await prisma.notificationPreference.createMany({ data: defaults });
  return prisma.notificationPreference.findMany({ where: { userId } });
}

export async function updatePreference(
  userId: string,
  eventType: string,
  channel: string,
  enabled: boolean,
) {
  return prisma.notificationPreference.upsert({
    where: { userId_eventType_channel: { userId, eventType, channel } },
    update: { enabled },
    create: { userId, eventType, channel, enabled },
  });
}

export async function shouldNotify(
  userId: string,
  eventType: string,
): Promise<boolean> {
  const pref = await prisma.notificationPreference.findUnique({
    where: { userId_eventType_channel: { userId, eventType, channel: 'in_app' } },
  });

  // Default to true if no preference exists
  if (!pref) return true;
  return pref.enabled;
}
