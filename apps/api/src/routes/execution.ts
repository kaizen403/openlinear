import { Router } from 'express';
import { prisma } from '@openlinear/db';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import {
  validateExecutionMetadataSync,
  safeValidateExecutionMetadataSync,
  type ExecutionMetadataSync,
} from '../types/execution-metadata';
import { broadcast } from '../sse';

const router: import('express').Router = Router();

/**
 * POST /api/execution/sync
 * 
 * Ingest execution metadata from desktop app.
 * Only metadata is synced - no prompts, logs, or secrets.
 * 
 * Request body must conform to ExecutionMetadataSync schema.
 * Forbidden fields will be rejected with 400 Bad Request.
 */
router.post('/sync', requireAuth, async (req, res) => {
  try {
    const validation = safeValidateExecutionMetadataSync(req.body);
    
    if (!validation.success) {
      const hasUnknownKeys = validation.error.errors.some(e =>
        e.message.includes('Unrecognized') || e.code === 'unrecognized_keys'
      );
      
      return res.status(400).json({
        error: 'Invalid sync payload',
        code: hasUnknownKeys ? 'FORBIDDEN_FIELDS' : 'VALIDATION_ERROR',
        details: validation.error.errors.map(e => ({
          field: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const metadata: ExecutionMetadataSync = validation.data;
    const userId = (req as AuthRequest).userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Verify task ownership
    const task = await prisma.task.findFirst({
      where: {
        id: metadata.taskId,
      },
      include: {
        project: {
          include: {
            projectTeams: true,
          },
        },
      },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Update task with metadata
    const updatedTask = await prisma.task.update({
      where: { id: metadata.taskId },
      data: {
        status: mapExecutionStatusToTaskStatus(metadata.status),
        executionStartedAt: metadata.startedAt ? new Date(metadata.startedAt) : undefined,
        executionElapsedMs: metadata.durationMs ?? 0,
        executionProgress: metadata.progress,
        prUrl: metadata.prUrl,
        outcome: metadata.outcome,
        // Store execution run reference
        sessionId: metadata.runId,
      },
    });

    // Broadcast update to connected clients
    broadcast('execution:task_updated', {
      taskId: metadata.taskId,
      status: metadata.status,
      progress: metadata.progress,
    });

    return res.status(200).json({
      success: true,
      task: updatedTask,
    });
  } catch (error) {
    console.error('Execution sync error:', error);
    return res.status(500).json({
      error: 'Internal server error',
    });
  }
});

/**
 * POST /api/execution/start
 * 
 * Signal that execution has started on desktop.
 */
router.post('/start', requireAuth, async (req, res) => {
  try {
    const { taskId, runId } = req.body;
    const userId = (req as AuthRequest).userId;

    if (!taskId || !runId) {
      return res.status(400).json({
        error: 'Missing required fields: taskId, runId',
      });
    }

    const task = await prisma.task.findFirst({
      where: { id: taskId },
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'in_progress',
        executionStartedAt: new Date(),
        sessionId: runId,
      },
    });

    broadcast('execution:started', {
      taskId,
      runId,
    });

    return res.status(200).json({
      success: true,
      task: updatedTask,
    });
  } catch (error) {
    console.error('Execution start error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/execution/progress
 * 
 * Update execution progress from desktop.
 */
router.post('/progress', requireAuth, async (req, res) => {
  try {
    const { taskId, progress } = req.body;
    const userId = (req as AuthRequest).userId;

    if (!taskId || typeof progress !== 'number') {
      return res.status(400).json({
        error: 'Missing required fields: taskId, progress',
      });
    }

    const task = await prisma.task.update({
      where: { id: taskId },
      data: {
        executionProgress: progress,
      },
    });

    broadcast('execution:progress', {
      taskId,
      progress,
    });

    return res.status(200).json({
      success: true,
      task,
    });
  } catch (error) {
    console.error('Execution progress error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/execution/finish
 * 
 * Signal that execution has completed/failed on desktop.
 */
router.post('/finish', requireAuth, async (req, res) => {
  try {
    const validation = safeValidateExecutionMetadataSync(req.body);
    
    if (!validation.success) {
      return res.status(400).json({
        error: 'Invalid finish payload',
        details: validation.error.errors,
      });
    }

    const metadata = validation.data;

    const task = await prisma.task.update({
      where: { id: metadata.taskId },
      data: {
        status: mapExecutionStatusToTaskStatus(metadata.status),
        executionElapsedMs: metadata.durationMs ?? 0,
        executionProgress: 100,
        prUrl: metadata.prUrl,
        outcome: metadata.outcome,
      },
    });

    broadcast('execution:finished', {
      taskId: metadata.taskId,
      status: metadata.status,
      prUrl: metadata.prUrl,
    });

    return res.status(200).json({
      success: true,
      task,
    });
  } catch (error) {
    console.error('Execution finish error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

function mapExecutionStatusToTaskStatus(status: ExecutionMetadataSync['status']) {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'cancelled';
    case 'cancelled':
      return 'cancelled';
    case 'running':
      return 'in_progress';
    case 'pending':
    default:
      return 'todo';
  }
}

export default router;
