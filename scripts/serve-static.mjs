#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';

const [rootArg, hostArg = '127.0.0.1', portArg = '3000'] = process.argv.slice(2);

if (!rootArg) {
  console.error('Usage: node scripts/serve-static.mjs <root> [host] [port]');
  process.exit(64);
}

const root = resolve(rootArg);
const host = hostArg;
const port = Number(portArg);

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error(`[static] Invalid port: ${portArg}`);
  process.exit(64);
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function isInsideRoot(filePath) {
  return filePath === root || filePath.startsWith(`${root}${sep}`);
}

async function existingFile(filePath) {
  if (!isInsideRoot(filePath)) return null;
  try {
    const fileStat = await stat(filePath);
    return fileStat.isFile() ? filePath : null;
  } catch {
    return null;
  }
}

async function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl ?? '/', `http://${host}:${port}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }

  if (pathname.includes('\0')) return null;

  const relativePath = normalize(pathname).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const requestedPath = resolve(root, relativePath);
  const candidates = [
    requestedPath,
    resolve(requestedPath, 'index.html'),
  ];

  if (!extname(requestedPath)) {
    candidates.push(`${requestedPath}.html`);
  }

  for (const candidate of candidates) {
    const filePath = await existingFile(candidate);
    if (filePath) return filePath;
  }

  return null;
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const filePath = await resolveRequestPath(req.url);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = extname(filePath);
  const headers = {
    'Content-Type': contentTypes.get(ext) ?? 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  };
  res.writeHead(200, headers);

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      res.end('Internal Server Error');
    })
    .pipe(res);
});

server.on('error', (error) => {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'EADDRINUSE') {
    console.error(`[static] ${host}:${port} is already in use`);
  } else {
    console.error('[static] Failed to start static server:', error);
  }
  process.exit(1);
});

server.listen({ host, port }, () => {
  console.log(`[static] Serving ${root} at http://${host}:${port}`);
});
