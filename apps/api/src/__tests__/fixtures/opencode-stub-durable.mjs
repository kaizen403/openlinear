// Deterministic stand-in for `opencode serve` for the W05a/W06a process-kill
// end-to-end test. Like fixtures/opencode-stub.mjs (no model, loopback only)
// plus what recovery needs: session status, session lookup, message list,
// abort bookkeeping, and test controls:
//   GET  /__stub/stats          prompts (count + texts)/aborts per session, open event streams
//   POST /__stub/release/:id    let a "[hold]" session finish its turn
// It writes `<STUB_PID_DIR>/<pid>.json` ({ pid, url }) so the test can find a
// stub that outlived its (SIGKILLed) sidecar and kill every stub afterwards.
//
// Prompts: "[hold]" stays busy until released, then writes one file and goes
// idle; "[hang]" stays busy until aborted; anything else writes one file and
// goes idle immediately.
import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
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
const prompts = {};
const promptTexts = {};
const aborts = {};
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

function finish(id, session) {
  if (session.status !== 'busy') return;
  // W07a: a follow-up turn on the same session changes the file again.
  writeFileSync(join(session.directory, `durable-${id}.txt`), `stub change ${prompts[id] ?? 0} for ${session.title}\n`);
  emit({ type: 'file.edited', properties: { sessionID: id, file: `durable-${id}.txt` } });
  setTimeout(() => {
    if (session.status !== 'busy') return;
    session.status = 'idle';
    session.messages.push({ info: { id: `msg_${id}_a`, role: 'assistant', sessionID: id }, parts: [] });
    emit({ type: 'session.idle', properties: { sessionID: id } });
  }, 50);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${host}`);
  const parts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'GET' && url.pathname === '/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`);
    streams.add(res);
    const beat = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'server.heartbeat', properties: {} })}\n\n`), 1_000);
    req.on('close', () => { clearInterval(beat); streams.delete(res); });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__stub/stats') {
    json(res, 200, {
      prompts,
      promptTexts,
      aborts,
      streams: streams.size,
      sessions: [...sessions.entries()].map(([id, session]) => ({ id, title: session.title, status: session.status })),
    });
    return;
  }
  if (req.method === 'POST' && parts[0] === '__stub' && parts[1] === 'release' && parts[2]) {
    const session = sessions.get(parts[2]);
    if (!session) return json(res, 404, { error: 'no session' });
    finish(parts[2], session);
    json(res, 200, true);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/config') {
    json(res, 200, { model: 'stub/model' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/session/status') {
    const status = {};
    for (const [id, session] of sessions) if (session.status === 'busy') status[id] = { type: 'busy' };
    json(res, 200, status);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/session') {
    const body = await readBody(req);
    const header = req.headers['x-opencode-directory'];
    const directory = url.searchParams.get('directory')
      ?? (typeof header === 'string' ? decodeURIComponent(header) : process.cwd());
    counter += 1;
    const id = `ses_durable${process.pid}_${counter}`;
    sessions.set(id, { directory, title: body.title ?? '', status: 'idle', messages: [] });
    json(res, 200, { id, title: body.title ?? '', directory, time: { created: Date.now(), updated: Date.now() } });
    return;
  }

  if (parts[0] === 'session' && parts[1]) {
    const id = parts[1];
    const session = sessions.get(id);
    if (!session) return json(res, 404, { name: 'NotFoundError', data: { message: 'session not found' } });
    if (req.method === 'GET' && parts.length === 2) return json(res, 200, { id, title: session.title, directory: session.directory });
    if (req.method === 'GET' && parts[2] === 'message') return json(res, 200, session.messages);
    if (req.method === 'POST' && parts[2] === 'prompt_async') {
      const body = await readBody(req);
      const text = (body.parts ?? []).map((part) => part.text ?? '').join('\n');
      prompts[id] = (prompts[id] ?? 0) + 1;
      promptTexts[id] = [...(promptTexts[id] ?? []), text];
      session.status = 'busy';
      session.messages.push({ info: { id: `msg_${id}_u${prompts[id]}`, role: 'user', sessionID: id }, parts: [] });
      res.writeHead(204);
      res.end();
      setTimeout(() => {
        emit({ type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } });
        emit({ type: 'message.part.updated', properties: { part: { type: 'text', id: `prt_${id}`, sessionID: id }, delta: 'Working on it (durable stub).' } });
        if (text.includes('[hold]') || text.includes('[hang]')) return;
        finish(id, session);
      }, 50);
      return;
    }
    if (req.method === 'POST' && parts[2] === 'abort') {
      aborts[id] = (aborts[id] ?? 0) + 1;
      if (session.status === 'busy') {
        session.status = 'idle';
        session.messages.push({ info: { id: `msg_${id}_x`, role: 'assistant', sessionID: id, error: { name: 'MessageAbortedError', data: { message: 'aborted' } } }, parts: [] });
        emit({ type: 'session.idle', properties: { sessionID: id } });
      }
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
  const listening = `http://${host}:${address.port}`;
  if (process.env.STUB_PID_DIR) {
    mkdirSync(process.env.STUB_PID_DIR, { recursive: true });
    writeFileSync(join(process.env.STUB_PID_DIR, `${process.pid}.json`), JSON.stringify({ pid: process.pid, url: listening }));
  }
  process.stdout.write(`opencode server listening on ${listening}\n`);
});

process.on('SIGTERM', () => {
  for (const res of streams) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
