// UI anônima com dispositivo pareado; API simulada (Gemini e câmera física não homologados).
// Uso: APP=http://127.0.0.1:3017 node tests/e2e/device-ocr-ui.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const app = process.env.APP || 'http://127.0.0.1:3017';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(app).hostname));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => localStorage.setItem('pp_device:teste-ocr', 'a'.repeat(64)));
  let calls = 0;
  await context.route('**/api/totem/*', async route => {
    assert.equal(route.request().headers()['x-device-secret'], 'a'.repeat(64));
    assert.equal(route.request().headers().authorization, undefined);
    if (route.request().url().endsWith('/context')) return route.fulfill({ json: { units: [{ id: 'u1', block: 'A', label: '12B' }] } });
    assert.ok(route.request().url().endsWith('/ocr'));
    assert.match(route.request().postDataJSON().imageBase64, /^data:image\/jpeg;base64,/);
    calls++;
    return route.fulfill({ json: { carrier: 'Correios', trackingCode: 'BR123', block: 'A', unit: '12B', confidence: 90 } });
  });
  const page = await context.newPage();
  await page.goto(`${app}/c/teste-ocr/totem`);
  await page.getByRole('button', { name: 'Escanear etiqueta (câmera)' }).waitFor();
  assert.equal(await page.getByText(/Sou da equipe/).count(), 0);
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = c.height = 100;
    const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 100, 100);
    ctx.fillStyle = 'black'; ctx.fillText('A 12B', 10, 40); return c.toDataURL().split(',')[1];
  });
  await page.locator('input[type=file]').setInputFiles({ name: 'label.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByText('Etiqueta lida. Confira unidade, transportadora e rastreio antes de enviar.').waitFor();
  assert.equal(await page.getByLabel('Rastreio').inputValue(), 'BR123');
  assert.equal(await page.getByLabel('Unidade', { exact: true }).inputValue(), 'u1');
  assert.equal(calls, 1);
  assert.match(page.url(), /\/totem$/);
  console.log('PASS: OCR no totem pareado sem conta, sem JWT, sem link de login. Provedor simulado.');
} finally { await browser.close(); }
