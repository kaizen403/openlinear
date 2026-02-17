import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { checkBrainstormAvailability, generateQuestions, generateTasks } from '../services/brainstorm';

const QuestionsSchema = z.object({
  prompt: z.string().min(1).max(5000),
  webSearch: z.boolean().optional().default(false),
});

const GenerateSchema = z.object({
  prompt: z.string().min(1).max(5000),
  answers: z.array(z.object({
    question: z.string(),
    answer: z.string(),
  })),
  webSearch: z.boolean().optional().default(false),
});

const router: Router = Router();

router.get('/availability', requireAuth, async (_req: AuthRequest, res: Response) => {
  try {
    const result = checkBrainstormAvailability();
    res.json(result);
  } catch (error) {
    console.error('[Brainstorm] Error checking availability:', error);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

router.post('/questions', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = QuestionsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { available } = checkBrainstormAvailability();
    if (!available) {
      res.status(503).json({ error: 'No AI provider configured' });
      return;
    }

    const questions = await generateQuestions(parsed.data.prompt, parsed.data.webSearch);
    res.json({ questions });
  } catch (error) {
    console.error('[Brainstorm] Error generating questions:', error);
    res.status(500).json({ error: 'Failed to generate questions' });
  }
});

router.post('/generate', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parsed = GenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
      return;
    }

    const { available } = checkBrainstormAvailability();
    if (!available) {
      res.status(503).json({ error: 'No AI provider configured' });
      return;
    }

    const { prompt, answers, webSearch } = parsed.data;

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    try {
      for await (const task of generateTasks(prompt, answers, webSearch)) {
        res.write(JSON.stringify(task) + '\n');
      }
      res.end();
    } catch (streamError) {
      console.error('[Brainstorm] Error during task generation stream:', streamError);
      const message = streamError instanceof Error ? streamError.message : 'Stream error';
      res.write(JSON.stringify({ error: message }) + '\n');
      res.end();
    }
  } catch (error) {
    console.error('[Brainstorm] Error generating tasks:', error);
    res.status(500).json({ error: 'Failed to generate tasks' });
  }
});

export default router;
