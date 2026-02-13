import { prisma } from '@openlinear/db';
import { getClient } from '../opencode';

import type { OpencodeClient } from '@opencode-ai/sdk';
import { appendTextDelta, appendReasoningDelta, flushDeltaBuffer, markThinking } from '../delta-buffer';

import { commitAndPush, createPullRequest } from './git';
import {
  activeExecutions,
  eventSubscriptionActive,
  broadcastProgress,
  addLogEntry,
  updateTaskStatus,
  persistLogs,
  cleanupExecution,
  getTaskTitle,
  findTaskBySessionId,
  setEventSubscriptionActive,
} from './state';

async function handleSessionComplete(taskId: string): Promise<void> {
  const execution = activeExecutions.get(taskId);
  if (!execution || execution.cancelled) return;

  const elapsedMs = Date.now() - execution.startedAt.getTime();
  let prUrl: string | null = null;
  let outcome: string | null = null;

  try {
    execution.status = 'committing';
    broadcastProgress(taskId, 'committing', 'Committing changes...');
    addLogEntry(taskId, 'info', 'Agent finished, committing changes...');

    const hasChanges = await commitAndPush(
      execution.repoPath,
      execution.branchName,
      await getTaskTitle(taskId)
    );

    if (hasChanges) {
      execution.status = 'creating_pr';
      broadcastProgress(taskId, 'creating_pr', 'Creating pull request...');
      addLogEntry(taskId, 'info', 'Creating pull request...');

      const repository = await prisma.repository.findUnique({
        where: { id: execution.projectId },
      });
      const task = await prisma.task.findUnique({ where: { id: taskId } });

      let repoInfo = repository
        ? { fullName: repository.fullName, defaultBranch: repository.defaultBranch }
        : null;

      if (!repoInfo && task?.projectId) {
        const project = await prisma.project.findUnique({
          where: { id: task.projectId },
          include: { repository: true },
        });
        if (project?.repository) {
          repoInfo = {
            fullName: project.repository.fullName,
            defaultBranch: project.repository.defaultBranch,
          };
        }
      }

      if (repoInfo) {
        const result = await createPullRequest(
          repoInfo.fullName,
          execution.branchName,
          repoInfo.defaultBranch,
          task?.title || 'Task',
          task?.description || null,
          execution.accessToken
        );

        prUrl = result.url;
        outcome = `${execution.filesChanged} file${execution.filesChanged !== 1 ? 's' : ''} changed, ${execution.toolsExecuted} tools executed`;

        if (result.type === 'pr') {
          addLogEntry(taskId, 'success', 'Pull request created', result.url);
          broadcastProgress(taskId, 'done', 'Pull request created', { prUrl: result.url, isCompareLink: false });
        } else {
          addLogEntry(taskId, 'success', 'Changes pushed! Create PR here:', result.url);
          broadcastProgress(taskId, 'done', 'Changes pushed successfully', { prUrl: result.url, isCompareLink: true });
        }
      }
    } else {
      outcome = 'Completed with no changes';
      addLogEntry(taskId, 'info', 'Completed with no changes');
      broadcastProgress(taskId, 'done', 'Completed with no changes');
    }

    await updateTaskStatus(taskId, 'done', null, {
      executionElapsedMs: elapsedMs,
      executionProgress: 100,
      prUrl,
      outcome,
    });
  } catch (error) {
    console.error('[Execution] Post-execution error:', error);
    addLogEntry(taskId, 'error', 'Post-execution failed');
    broadcastProgress(taskId, 'error', 'Post-execution failed');
  } finally {
    await persistLogs(taskId);
    await cleanupExecution(taskId);
  }
}

// Extract session ID from various OpenCode event structures
function extractSessionId(event: { type: string; properties?: Record<string, unknown> }): string | undefined {
  const props = event.properties || {};
  
  // Direct sessionID on properties
  if (typeof props.sessionID === 'string') return props.sessionID;
  
  // Direct id on properties (for session.* events)
  if (typeof props.id === 'string' && props.id.startsWith('ses_')) return props.id;
  
  // Nested in info object
  const info = props.info as { id?: string; sessionID?: string } | undefined;
  if (info?.sessionID) return info.sessionID;
  if (info?.id && typeof info.id === 'string' && info.id.startsWith('ses_')) return info.id;
  
  // Nested in part object
  const part = props.part as { sessionID?: string } | undefined;
  if (part?.sessionID) return part.sessionID;
  
  // Nested in session object
  const session = props.session as { id?: string } | undefined;
  if (session?.id) return session.id;
  
  return undefined;
}

async function handleOpenCodeEvent(event: { type: string; properties?: Record<string, unknown> }): Promise<void> {
  if (event.type === 'server.heartbeat') return;
  
  const sessionId = extractSessionId(event);
  const taskId = sessionId ? findTaskBySessionId(sessionId) : undefined;

  switch (event.type) {
    case 'session.idle':
    case 'session.completed':
      if (taskId) {
        const execution = activeExecutions.get(taskId);
        if (!execution?.promptSent || execution.cancelled) {
          console.log(`[Execution] Ignoring ${event.type} for task ${taskId.slice(0, 8)} (${!execution?.promptSent ? 'prompt not yet sent' : 'cancelled'})`);
          break;
        }
        flushDeltaBuffer(taskId);
        addLogEntry(taskId, 'success', 'Agent completed work');
        await handleSessionComplete(taskId);
      }
      break;

    case 'session.error':
      if (taskId) {
        const errorMsg = (event.properties?.error as string) || 'Unknown error';
        addLogEntry(taskId, 'error', 'Execution failed', errorMsg);
        broadcastProgress(taskId, 'error', 'Execution failed');
        await updateTaskStatus(taskId, 'cancelled', null);
        await persistLogs(taskId);
        await cleanupExecution(taskId);
      }
      break;

    case 'session.status': {
      if (!taskId) break;
      const status = event.properties?.status as { type?: string; message?: string };
      if (status?.type === 'busy') {
        const execution = activeExecutions.get(taskId);
        if (execution) execution.promptSent = true;
        if (markThinking(taskId)) {
          addLogEntry(taskId, 'agent', 'Agent is thinking...');
        }
        broadcastProgress(taskId, 'executing', 'Agent is thinking...');
      } else if (status?.type === 'retry') {
        addLogEntry(taskId, 'info', `Retrying: ${status.message || 'unknown reason'}`);
      }
      break;
    }

    case 'message.part.updated': {
      if (!taskId) break;
      const part = event.properties?.part as { type?: string; text?: string; tool?: string; state?: { status?: string; title?: string; output?: string } };
      const delta = event.properties?.delta as string;

      if (part?.type === 'text' && delta) {
        appendTextDelta(taskId, delta);
      } else if (part?.type === 'tool') {
        flushDeltaBuffer(taskId);
        const toolName = part.tool || 'unknown tool';
        const state = part.state;
        if (state?.status === 'running') {
          addLogEntry(taskId, 'tool', `Running: ${state.title || toolName}`);
          broadcastProgress(taskId, 'executing', `Running: ${state.title || toolName}`);
        } else if (state?.status === 'completed') {
          const output = state.output?.slice(0, 100) || '';
          addLogEntry(taskId, 'success', `Completed: ${toolName}`, output);
        } else if (state?.status === 'error') {
          addLogEntry(taskId, 'error', `Failed: ${toolName}`, state.output);
        }
      } else if (part?.type === 'reasoning') {
        if (delta && delta.length > 0) {
          appendReasoningDelta(taskId, delta);
        }
      }
      break;
    }

    case 'tool.execute.before': {
      if (!taskId) break;
      flushDeltaBuffer(taskId);
      const tool = event.properties?.tool as string;
      if (tool) {
        addLogEntry(taskId, 'tool', `Starting: ${tool}`);
      }
      break;
    }

    case 'tool.execute.after': {
      if (!taskId) break;
      const tool = event.properties?.tool as string;
      const output = event.properties?.output as string;
      if (tool) {
        const execution = activeExecutions.get(taskId);
        if (execution) execution.toolsExecuted++;
        addLogEntry(taskId, 'success', `Finished: ${tool}`, output?.slice(0, 100));
      }
      break;
    }

    case 'file.edited': {
      if (!taskId) break;
      const file = event.properties?.file as string;
      if (file) {
        const execution = activeExecutions.get(taskId);
        if (execution) execution.filesChanged++;
        addLogEntry(taskId, 'success', `Edited file: ${file}`);
      }
      break;
    }

    default:
      break;
  }
}

export async function initEventSubscription(): Promise<void> {
  if (eventSubscriptionActive) return;

  try {
    const events = await getClient().event.subscribe();
    setEventSubscriptionActive(true);
    console.log('[Execution] Global event subscription initialized');

    (async () => {
      try {
        for await (const event of events.stream) {
          await handleOpenCodeEvent(event);
        }
      } catch (error) {
        console.error('[Execution] Event stream error:', error);
        setEventSubscriptionActive(false);
        setTimeout(() => initEventSubscription(), 5000);
      }
    })();
  } catch (error) {
    console.error('[Execution] Failed to initialize event subscription:', error);
    setEventSubscriptionActive(false);
  }
}

export async function subscribeToSessionEvents(taskId: string, client: OpencodeClient, sessionId: string): Promise<void> {
  try {
    const events = await client.event.subscribe();
    
    (async () => {
      try {
        for await (const event of events.stream) {
          const eventSessionId = extractSessionId(event);
          if (eventSessionId === sessionId) {
            await handleOpenCodeEvent(event);
          }
        }
      } catch (error) {
        console.error(`[Execution] Event stream error for task ${taskId.slice(0, 8)}:`, error);
      }
    })();
  } catch (error) {
    console.error(`[Execution] Failed to subscribe to events for task ${taskId.slice(0, 8)}:`, error);
    addLogEntry(taskId, 'error', 'Failed to subscribe to agent events');
  }
}
