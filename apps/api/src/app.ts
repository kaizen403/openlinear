import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import labelRoutes from './routes/labels';
import tasksRouter from './routes/tasks';
import settingsRouter from './routes/settings';
import batchesRouter from './routes/batches';
import authRouter from './routes/auth';
import reposRouter from './routes/repos';
import teamsRouter from './routes/teams';
import projectsRouter from './routes/projects';
import inboxRouter from './routes/inbox';
import opencodeRouter from './routes/opencode';
import brainstormRouter from './routes/brainstorm';
import { clients, SSEClient } from './sse';

export function createApp(): Application {
  const app: Application = express();

  app.use(cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  }));
  app.use(express.json());
  app.use(cookieParser());

  app.use('/api/auth', authRouter);
  app.use('/api/repos', reposRouter);
  app.use('/api/labels', labelRoutes);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/batches', batchesRouter);
  app.use('/api/teams', teamsRouter);
  app.use('/api/projects', projectsRouter);
  app.use('/api/inbox', inboxRouter);
  app.use('/api/opencode', opencodeRouter);
  app.use('/api/brainstorm', brainstormRouter);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      clients: clients.size
    });
  });

  app.get('/api/events', (req: Request, res: Response) => {
    const clientId = req.query.clientId as string || crypto.randomUUID();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const client: SSEClient = { id: clientId, res };
    clients.set(clientId, client);

    console.log(`[SSE] Client connected: ${clientId} (total: ${clients.size})`);

    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    const heartbeatInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`: heartbeat\n\n`);
      }
    }, 30000);

    const cleanup = () => {
      clearInterval(heartbeatInterval);
      clients.delete(clientId);
      console.log(`[SSE] Client disconnected: ${clientId} (total: ${clients.size})`);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  return app;
}
