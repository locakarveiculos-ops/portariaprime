// Build real + navegador real; nenhum backend ou formulário enviado.
// Uso: npm run build && node tests/pwa-update.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

let version = 1;
const root = resolve('dist');
const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    let body;
    try { body = await readFile(file); } catch { body = await readFile(resolve(root, 'index.html')); }
    if (pathname === '/sw.js') body = Buffer.concat([body, Buffer.from(`\n// versão de teste ${version}\n`)]);
    res.writeHead(200, { 'Content-Type': types[extname(pathname)] || 'text/html', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.getByRole('heading', { name: 'Entrar', exact: true }).waitFor();
  const email = page.getByLabel('E-mail', { exact: true });
  await email.fill('rascunho@example.invalid');
  version = 2;
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  const update = page.getByRole('button', { name: 'Atualizar aplicativo' });
  await update.waitFor({ timeout: 20000 });
  assert.equal(await email.inputValue(), 'rascunho@example.invalid', 'Atualização não pode apagar o rascunho sem confirmação');
  await Promise.all([page.waitForEvent('load'), update.click()]);
  await page.getByRole('heading', { name: 'Entrar', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Atualizar aplicativo' }).count(), 0);
  console.log('PASS: novo worker oferece atualização; preserva rascunho até o clique; clique recarrega.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
