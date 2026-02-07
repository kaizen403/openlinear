import { Response } from 'express';

export interface SSEClient {
  id: string;
  res: Response;
}

export const clients: Map<string, SSEClient> = new Map();

export function broadcast(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  
  let sentCount = 0;
  clients.forEach((client) => {
    if (!client.res.writableEnded) {
      client.res.write(message);
      sentCount++;
    }
  });
  
  if (event.startsWith('execution:')) {
    console.log(`[SSE] Broadcast ${event} to ${sentCount} client(s)`);
  }
}

export function sendToClient(clientId: string, event: string, data: unknown): boolean {
  const client = clients.get(clientId);
  if (client && !client.res.writableEnded) {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  }
  return false;
}

export function getClientCount(): number {
  return clients.size;
}
