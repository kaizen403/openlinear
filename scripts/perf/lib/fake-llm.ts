/**
 * Minimal OpenAI-compatible `/chat/completions` stand-in so chat streaming can
 * be timed without paid inference. Streams a fixed short answer (no tool
 * calls) immediately; PERF_FAKE_LLM_DELAY_MS adds an artificial first-token
 * delay. Bound to 127.0.0.1 only.
 */
import { createServer, type Server } from 'node:http';

export interface FakeLlm {
  url: string;
  requests: () => number;
  close: () => Promise<void>;
}

export async function startFakeLlm(port: number, firstTokenDelayMs = 0): Promise<FakeLlm> {
  let requests = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests += 1;
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      let stream = false;
      try {
        stream = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { stream?: boolean }).stream === true;
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Perf bench title' } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const words = ['The ', 'board ', 'looks ', 'healthy.'];
      setTimeout(() => {
        for (const word of words) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: word } }] })}\n\n`);
        }
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 4 } })}\n\n`,
        );
        res.end('data: [DONE]\n\n');
      }, firstTokenDelayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
