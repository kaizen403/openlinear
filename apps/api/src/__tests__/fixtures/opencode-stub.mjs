// Deterministic stand-in for `opencode serve` used by the W03a end-to-end
// test. No model, no network beyond loopback. It implements only the HTTP
// surface the sidecar's @opencode-ai/sdk v1 client uses:
//   GET  /event                          (SSE event stream)
//   POST /session                        (create; ?directory=)
//   GET  /config
//   POST /session/:id/prompt_async       (204; then scripted events)
//   POST /session/:id/abort              (true)
//   POST /session/:id/permissions/:pid   (true)
// A prompt containing "[hang]" keeps the session busy until aborted;
// otherwise the stub writes one file into the session directory and goes idle.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

function arg(name) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const host = arg('hostname') ?? '127.0.0.1';
const port = Number(arg('port') ?? 0);
const sessions = new Map();
const streams = new Set();
let counter = 0;

function emit(event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of streams) res.write(frame);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    streams.add(res);
    const beat = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'server.heartbeat', properties: {} })}\n\n`), 2_000);
    req.on('close', () => { clearInterval(beat); streams.delete(res); });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/config') {
    json(res, 200, { model: 'stub/model' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/session') {
    const body = await readBody(req);
    const header = req.headers['x-opencode-directory'];
    const directory = url.searchParams.get('directory')
      ?? (typeof header === 'string' ? decodeURIComponent(header) : process.cwd());
    counter += 1;
    const id = `ses_stub${counter}`;
    sessions.set(id, { directory, title: body.title ?? '', aborted: false });
    json(res, 200, { id, title: body.title ?? '', directory, time: { created: Date.now(), updated: Date.now() } });
    return;
  }

  if (parts[0] === 'session' && parts[1] && sessions.has(parts[1])) {
    const id = parts[1];
    const session = sessions.get(id);
    if (req.method === 'POST' && parts[2] === 'prompt_async') {
      const body = await readBody(req);
      const text = (body.parts ?? []).map((part) => part.text ?? '').join('\n');
      res.writeHead(204);
      res.end();
      setTimeout(() => {
        emit({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
        emit({ type: 'message.part.updated', properties: { part: { type: 'text', sessionID: id }, delta: 'Working on it (stub).' } });
        if (text.includes('[hang]')) return;
        writeFileSync(join(session.directory, 'w03a-e2e-change.txt'), `stub change for ${session.title}\n`);
        emit({ type: 'file.edited', properties: { sessionID: id, file: 'w03a-e2e-change.txt' } });
        setTimeout(() => {
          if (!session.aborted) emit({ type: 'session.idle', properties: { sessionID: id } });
        }, 50);
      }, 50);
      return;
    }
    if (req.method === 'POST' && parts[2] === 'abort') {
      session.aborted = true;
      json(res, 200, true);
      return;
    }
    if (req.method === 'POST' && parts[2] === 'permissions') {
      json(res, 200, true);
      return;
    }
  }

  json(res, 404, { error: 'not found in opencode stub' });
});

server.listen(port, host, () => {
  const address = server.address();
  process.stdout.write(`opencode server listening on http://${host}:${address.port}\n`);
});

process.on('SIGTERM', () => {
  for (const res of streams) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
