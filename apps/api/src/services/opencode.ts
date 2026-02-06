import { createOpencodeClient } from '@opencode-ai/sdk';
import { prisma } from '@openlinear/db';
import { broadcast } from '../sse';

const OPENCODE_BASE_URL = process.env.OPENCODE_URL || 'http://localhost:4096';
const TASK_TIMEOUT_MS = 30 * 60 * 1000;

const client = createOpencodeClient({
  baseUrl: OPENCODE_BASE_URL,
});

interface Label {
  id: string;
  name: string;
  color: string;
  priority: number;
}

interface TaskLabel {
  taskId: string;
  labelId: string;
  label: Label;
}

interface TaskWithLabels {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  status: string;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  labels: TaskLabel[];
}

interface ActiveSession {
  sessionId: string;
  timeoutId: NodeJS.Timeout;
}

const activeSessions = new Map<string, ActiveSession>();
let eventSubscriptionActive = false;

export function getRunningTaskCount(): number {
  return activeSessions.size;
}

export function isTaskRunning(taskId: string): boolean {
  return activeSessions.has(taskId);
}

function flattenLabels(task: TaskWithLabels) {
  return {
    ...task,
    labels: task.labels.map((tl: TaskLabel) => tl.label),
  };
}

function findTaskBySessionId(sessionId: string): string | undefined {
  for (const [taskId, session] of activeSessions.entries()) {
    if (session.sessionId === sessionId) {
      return taskId;
    }
  }
  return undefined;
}

async function updateTaskStatus(
  taskId: string,
  status: 'in_progress' | 'done' | 'cancelled',
  sessionId: string | null
): Promise<void> {
  try {
    const task = await prisma.task.update({
      where: { id: taskId },
      data: { status, sessionId },
      include: {
        labels: { include: { label: true } },
      },
    });
    broadcast('task:updated', flattenLabels(task as TaskWithLabels));
    console.log(`[OpenCode] Task ${taskId} status: ${status}`);
  } catch (error) {
    console.error(`[OpenCode] Failed to update task ${taskId}:`, error);
  }
}

async function completeTask(taskId: string, status: 'done' | 'cancelled'): Promise<void> {
  const session = activeSessions.get(taskId);
  if (session) {
    clearTimeout(session.timeoutId);
    activeSessions.delete(taskId);
  }
  await updateTaskStatus(taskId, status, null);
}

async function handleOpenCodeEvent(event: { type: string; properties: Record<string, unknown> }): Promise<void> {
  const sessionId = (event.properties?.id as string) || (event.properties?.sessionID as string);
  const taskId = findTaskBySessionId(sessionId);

  if (!taskId) return;

  switch (event.type) {
    case 'session.idle':
    case 'session.completed':
      console.log(`[OpenCode] Session completed for task ${taskId}`);
      await completeTask(taskId, 'done');
      break;

    case 'session.error':
      console.error(`[OpenCode] Session error for task ${taskId}:`, event.properties);
      await completeTask(taskId, 'cancelled');
      break;
  }
}

export async function initEventSubscription(): Promise<void> {
  if (eventSubscriptionActive) return;

  try {
    const events = await client.event.subscribe();
    eventSubscriptionActive = true;
    console.log('[OpenCode] Event subscription initialized');

    (async () => {
      try {
        for await (const event of events.stream) {
          await handleOpenCodeEvent(event);
        }
      } catch (error) {
        console.error('[OpenCode] Event stream error:', error);
        eventSubscriptionActive = false;
        setTimeout(() => initEventSubscription(), 5000);
      }
    })();
  } catch (error) {
    console.error('[OpenCode] Failed to initialize event subscription:', error);
    eventSubscriptionActive = false;
  }
}

function buildTaskPrompt(task: TaskWithLabels): string {
  let prompt = task.title;

  if (task.description) {
    prompt += `\n\n${task.description}`;
  }

  if (task.labels.length > 0) {
    const labelNames = task.labels.map((tl: TaskLabel) => tl.label.name).join(', ');
    prompt += `\n\nLabels: ${labelNames}`;
  }

  return prompt;
}

export async function executeTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  if (activeSessions.has(taskId)) {
    return { success: false, error: 'Task is already running' };
  }

  const settings = await prisma.settings.findFirst({ where: { id: 'default' } });
  const parallelLimit = settings?.parallelLimit ?? 3;

  if (activeSessions.size >= parallelLimit) {
    return { success: false, error: `Parallel limit reached (${parallelLimit} tasks max)` };
  }

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    include: { labels: { include: { label: true } } },
  });

  if (!task) {
    return { success: false, error: 'Task not found' };
  }

  try {
    const sessionResponse = await client.session.create({
      body: { title: task.title },
    });

    const sessionId = sessionResponse.data?.id;
    if (!sessionId) {
      return { success: false, error: 'Failed to create OpenCode session' };
    }

    const timeoutId = setTimeout(async () => {
      console.log(`[OpenCode] Task ${taskId} timed out after 30 minutes`);
      await cancelTask(taskId);
    }, TASK_TIMEOUT_MS);

    activeSessions.set(taskId, { sessionId, timeoutId });
    await updateTaskStatus(taskId, 'in_progress', sessionId);

    const prompt = buildTaskPrompt(task as TaskWithLabels);
    client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: 'text', text: prompt }] },
    }).catch((error) => {
      console.error(`[OpenCode] Prompt error for task ${taskId}:`, error);
    });

    console.log(`[OpenCode] Started execution for task ${taskId} (session: ${sessionId})`);
    return { success: true };
  } catch (error) {
    console.error(`[OpenCode] Failed to execute task ${taskId}:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function cancelTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const session = activeSessions.get(taskId);

  if (!session) {
    return { success: false, error: 'Task is not running' };
  }

  try {
    await client.session.abort({ path: { id: session.sessionId } });
    await completeTask(taskId, 'cancelled');
    console.log(`[OpenCode] Cancelled task ${taskId}`);
    return { success: true };
  } catch (error) {
    console.error(`[OpenCode] Failed to cancel task ${taskId}:`, error);
    await completeTask(taskId, 'cancelled');
    return { success: true, error: error instanceof Error ? error.message : 'Abort may have failed' };
  }
}

initEventSubscription();
