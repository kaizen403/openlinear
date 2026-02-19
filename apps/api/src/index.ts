import { config } from 'dotenv';
import { resolve } from 'path';
import express from 'express';

config({ path: resolve(import.meta.dirname, '../../../.env') });

import { createApp } from './app';
import { broadcast, sendToClient, getClientCount } from './sse';
import { initOpenCode, registerShutdownHandlers } from './services/opencode';

const app = createApp();
const PORT = Number(process.env.API_PORT ?? 3001);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

registerShutdownHandlers();

async function start() {
  try {
    await initOpenCode();
    console.log('[API] Container-per-user mode ready');
  } catch (error) {
    console.error('[API] Failed to initialize container manager:', error);
    console.warn('[API] Continuing without containers - task execution will fail');
  }

  app.listen(PORT, () => {
    console.log(`[API] Server running on http://localhost:${PORT}`);
    console.log(`[API] Health: http://localhost:${PORT}/health`);
    console.log(`[API] SSE: http://localhost:${PORT}/api/events`);
  });

  const interceptApp = express();
  interceptApp.get('/auth/callback', (req, res) => {
    const searchParams = new URLSearchParams(req.query as Record<string, string>);
    res.redirect(`${FRONTEND_URL}/auth/callback?${searchParams.toString()}`);
  });
  
  interceptApp.listen(1455, () => {
    console.log(`[API] OAuth Interceptor running on http://localhost:1455`);
  }).on('error', (err) => {
    console.warn(`[API] Could not start OAuth Interceptor on port 1455: ${err.message}`);
  });
}

start();

export { app, broadcast, sendToClient, getClientCount };
