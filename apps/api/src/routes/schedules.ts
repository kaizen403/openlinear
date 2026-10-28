import { Router, type Response } from 'express';
import { requireAuth, type AuthRequest } from '../middleware/auth';
import { validateBody, type ValidatedRequest } from '../middleware/validate';
import {
  createScheduleBodySchema,
  updateScheduleBodySchema,
  type CreateScheduleBody,
  type UpdateScheduleBody,
} from '../schemas/schedules';
import { respondIdempotently } from '../services/idempotency';
import {
  authorizeCreateSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  updateSchedule,
} from '../services/schedules';

/**
 * W20 / FE-14 recurring issues (services/schedules.ts). Mounted twice:
 * project-scoped list/create under `/api/projects`, schedule operations under
 * `/api/schedules`.
 */

export const projectSchedulesRouter: Router = Router();

projectSchedulesRouter.get('/:id/schedules', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await listSchedules({ projectId: req.params.id as string, userId: req.userId! }));
});

// Optional `Idempotency-Key` (W04a): equal retries replay, different bodies get 409.
projectSchedulesRouter.post('/:id/schedules', requireAuth(['tasks:write']), validateBody(createScheduleBodySchema),
  async (req: AuthRequest & ValidatedRequest<CreateScheduleBody>, res: Response) => {
    const projectId = req.params.id as string;
    const body = req.validBody!;
    await respondIdempotently(req, res, {
      operation: 'schedules.create',
      args: { params: { id: projectId }, body },
      authorize: () => authorizeCreateSchedule({ projectId, userId: req.userId!, body }),
    });
  },
);

export const schedulesRouter: Router = Router();

schedulesRouter.get('/:scheduleId', requireAuth, async (req: AuthRequest, res: Response) => {
  res.json(await getSchedule({ scheduleId: req.params.scheduleId as string, userId: req.userId! }));
});

schedulesRouter.patch('/:scheduleId', requireAuth(['tasks:write']), validateBody(updateScheduleBodySchema),
  async (req: AuthRequest & ValidatedRequest<UpdateScheduleBody>, res: Response) => {
    res.json(await updateSchedule({ scheduleId: req.params.scheduleId as string, userId: req.userId!, body: req.validBody! }));
  },
);

schedulesRouter.delete('/:scheduleId', requireAuth(['tasks:write']), async (req: AuthRequest, res: Response) => {
  await deleteSchedule({ scheduleId: req.params.scheduleId as string, userId: req.userId! });
  res.status(204).send();
});

schedulesRouter.post('/:scheduleId/pause', requireAuth(['tasks:write']), async (req: AuthRequest, res: Response) => {
  res.json(await pauseSchedule({ scheduleId: req.params.scheduleId as string, userId: req.userId! }));
});

schedulesRouter.post('/:scheduleId/resume', requireAuth(['tasks:write']), async (req: AuthRequest, res: Response) => {
  res.json(await resumeSchedule({ scheduleId: req.params.scheduleId as string, userId: req.userId! }));
});

// One issue per schedule per minute: a repeat answers 200 with the same occurrence.
schedulesRouter.post('/:scheduleId/run-now', requireAuth(['tasks:write']), async (req: AuthRequest, res: Response) => {
  const result = await runScheduleNow({ scheduleId: req.params.scheduleId as string, userId: req.userId! });
  res.status(result.created ? 201 : 200).json(result);
});
