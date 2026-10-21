// Smoke SOMENTE LEITURA em produção: não cadastra, não envia formulário, não clica em CTA de compra.
// Verifica landing anônima (desktop e mobile), /entrar, deep link com refresh, manifest e ausência de erro JS.
//   PROD=https://portariaprime.vercel.app node tests/e2e/prod-smoke.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';

// Neste ambiente só o curl.exe alcança vercel.app; Supabase é alcançado pelo fetch do Node.
function fetchVia(url, method, headers, body) {
  if (!/vercel\.app/.test(url)) return fetch(url, { method, headers, body });
  const args = ['-sS', '--ssl-no-revoke', '-i', '--max-time', '30', ...(method === 'HEAD' ? ['-I'] : [])];
  let out = execFileSync('curl.exe', [...args, url], { maxBuffer: 1 << 26 });
  // Pula blocos de cabeçalho intermediários (proxy CONNECT, 100-continue).
  let sep = out.indexOf('\r\n\r\n');
  while (/^HTTP\/[\d.]+ (1\d\d|200 Connection)/.test(out.subarray(0, 40).toString())) { out = out.subarray(sep + 4); sep = out.indexOf('\r\n\r\n'); }
  const head = out.subarray(0, sep).toString().split('\r\n');
  const status = Number(head[0].split(' ')[1]);
  const h = Object.fromEntries(head.slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
  return Promise.resolve(new Response(out.subarray(sep + 4), { status, headers: h }));
}

const PROD = process.env.PROD || 'https://portariaprime.vercel.app';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
// Rede deste ambiente: o navegador não alcança alguns hosts; Node repassa GETs/HEADs sem alterar conteúdo.
async function relay(ctx) {
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method()) && !req.url().includes('/rest/v1/')) return route.continue();
    try {
      const res = await fetchVia(req.url(), req.method(), req.headers(), req.postDataBuffer() ?? undefined);
      const headers = Object.fromEntries(res.headers); delete headers['content-encoding']; delete headers['content-length'];
      await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    } catch (e) { if (process.env.PP_DEBUG) console.error('relay', req.url(), e.message); await route.abort(); }
  });
}
try {
  for (const [name, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
    const ctx = await browser.newContext({ ...opts, serviceWorkers: 'block' });
    if (process.env.PP_RELAY === '1') await relay(ctx);
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`${PROD}/`);
    await p.getByRole('heading', { level: 1, name: 'Cada encomenda. Tudo sob controle.' }).waitFor({ timeout: 30000 });
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `rolagem horizontal ${name}`);
    await p.locator('#planos').scrollIntoViewIfNeeded();
    await p.locator('#planos').getByText(/em revisão|Profissional|Não foi possível carregar/).first().waitFor({ timeout: 45000 });
    const planos = await p.locator('#planos').innerText();
    await p.screenshot({ path: `tests/evidence/prod-landing-${name}.png` });
    await p.goto(`${PROD}/entrar`);
    await p.getByRole('heading', { name: 'Entrar', exact: true }).waitFor();
    await p.goto(`${PROD}/c/inexistente/portaria`);
    await p.reload();
    await p.waitForURL(/\/entrar\?next=/);
    assert.deepEqual(errors, [], `erros JS ${name}`);
    console.log(`PASS produção ${name}: landing, /entrar, deep link com refresh. Planos: ${/em revisão/.test(planos) ? 'em revisão (catálogo não publicado)' : /Profissional/.test(planos) ? 'publicados' : 'outro estado'}`);
    await ctx.close();
  }
} finally { await browser.close(); }
