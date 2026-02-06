import { createApp } from './app';
import { broadcast, sendToClient, getClientCount } from './sse';

const app = createApp();
const PORT = 3001;

app.listen(PORT, () => {
  console.log(`[API] Server running on http://localhost:${PORT}`);
  console.log(`[API] Health: http://localhost:${PORT}/health`);
  console.log(`[API] SSE: http://localhost:${PORT}/api/events`);
});

export { app, broadcast, sendToClient, getClientCount };
