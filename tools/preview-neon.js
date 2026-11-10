// Local preview of the Vercel + Neon version. Do not use as a production server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../api/handler.js';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to a disposable PostgreSQL database before starting this preview.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const files = new Map([
  ['/', ['neon.html', 'text/html']], ['/teacher', ['neon-teacher.html', 'text/html']],
  ['/simple.css', ['simple.css', 'text/css']], ['/neon-student.js', ['neon-student.js', 'text/javascript']],
  ['/neon-teacher.js', ['neon-teacher.js', 'text/javascript']]
]);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/simple/')) return handler(req, res);
  const file = files.get(url.pathname);
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  try { const contents = await fs.promises.readFile(path.join(root, file[0])); res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store' }); res.end(contents); }
  catch { res.writeHead(500); res.end('Unable to read page'); }
}).listen(Number(process.env.PORT) || 4001, process.env.HOST || '0.0.0.0', () => console.log('Simplified exam preview is running.'));
