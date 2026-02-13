import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve(import.meta.dirname, '../../../.env') });

import { createApp } from './app';
import { broadcast, sendToClient, getClientCount } from './sse';
import { initOpenCode, registerShutdownHandlers } from './services/opencode';

const app = createApp();
const PORT = Number(process.env.API_PORT ?? 3001);

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
}

start();

export { app, broadcast, sendToClient, getClientCount };
