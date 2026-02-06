import { createApp } from './app';
import { broadcast, sendToClient, getClientCount } from './sse';
import { ensureOpenCodeServer, registerShutdownHandlers, getOpenCodeStatus } from './services/opencode';
import { initEventSubscription } from './services/execution';

const app = createApp();
const PORT = 3001;

registerShutdownHandlers();

app.get('/api/opencode/status', (_req, res) => {
  res.json(getOpenCodeStatus());
});

async function start() {
  try {
    await ensureOpenCodeServer();
    console.log('[API] OpenCode server ready');
    
    initEventSubscription();
    console.log('[API] Event subscription initialized');
  } catch (error) {
    console.error('[API] Failed to start OpenCode server:', error);
    console.warn('[API] Continuing without OpenCode - task execution will fail');
  }

  app.listen(PORT, () => {
    console.log(`[API] Server running on http://localhost:${PORT}`);
    console.log(`[API] Health: http://localhost:${PORT}/health`);
    console.log(`[API] SSE: http://localhost:${PORT}/api/events`);
  });
}

start();

export { app, broadcast, sendToClient, getClientCount };
