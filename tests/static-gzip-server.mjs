// Servidor estático com gzip (como a Vercel serve) para medir Lighthouse realista: node tests/static-gzip-server.mjs dist-stack 4174
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(process.argv[2] || 'dist');
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  let file = resolve(root, `.${p}`);
  let body;
  try { body = await readFile(file); } catch { file = resolve(root, 'index.html'); body = await readFile(file); }
  const type = types[extname(file)] || 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (/text|javascript|json|manifest|svg/.test(type) && /gzip/.test(req.headers['accept-encoding'] || '')) { body = gzipSync(body); headers['content-encoding'] = 'gzip'; }
  res.writeHead(200, headers).end(body);
}).listen(Number(process.argv[3] || 4174), '127.0.0.1');
