/** Minimal zero-dependency HTTP helpers: router, JSON bodies, static files, SSE. */
import fs from 'node:fs';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8'
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(text);
}

export async function readJsonBody(req, limitBytes = 2_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export async function readTextBody(req, limitBytes = 4_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------ router */

export function createRouter() {
  const routes = [];

  const add = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern
          .split('/')
          .map((part) => {
            if (part.startsWith(':')) {
              keys.push(part.slice(1));
              return '([^/]+)';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('/') +
        '/?$'
    );
    routes.push({ method, regex, keys, handler, opts });
  };

  return {
    get: (p, h, o) => add('GET', p, h, o),
    post: (p, h, o) => add('POST', p, h, o),
    put: (p, h, o) => add('PUT', p, h, o),
    delete: (p, h, o) => add('DELETE', p, h, o),
    async handle(req, res, url) {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const m = url.pathname.match(route.regex);
        if (!m) continue;
        const params = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        req.params = params;
        return route.handler(req, res, url);
      }
      return false;
    }
  };
}

/* ------------------------------------------------------------------ static */

export function serveStatic(res, rootDir, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.normalize(path.join(rootDir, rel));
  if (!filePath.startsWith(path.normalize(rootDir))) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache'
  });
  res.end(body);
  return true;
}

/* --------------------------------------------------------------------- SSE */

export class SseHub {
  constructor() {
    this.clients = new Set();
    this.timer = null;
  }

  get size() {
    return this.clients.size;
  }

  add(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    res.write(':ok\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    return res;
  }

  send(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Keeps proxies from closing idle streams. */
  startHeartbeat(ms = 15000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.send('ping', { at: Date.now() }), ms);
    this.timer.unref?.();
  }

  /** End long-lived streams so an HTTP server can drain during shutdown. */
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const client of this.clients) {
      try { client.end(); } catch { /* connection already gone */ }
    }
    this.clients.clear();
  }
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket?.remoteAddress || '';
}
