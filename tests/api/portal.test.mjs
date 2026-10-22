// Manifest e página do portal: identidade do condomínio do slug; desconhecido = 404, nunca outro.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../../api/portal/[action].ts';

test('manifest por condomínio, escopo próprio, slug inválido/desconhecido recusado e HTML com head do condomínio', async () => {
  const saved = { ...process.env }; const fetch0 = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_ROLE_KEY: 'k', APP_URL: 'https://app.example' });
  const tenants = {
    'cond-a': { slug: 'cond-a', name: 'Residencial <A>', tenant_id: 'ta', color_primary: '#126B61', status: 'active', icons_version: 1700000000000 },
    'cond-b': { slug: 'cond-b', name: 'Condomínio B', tenant_id: 'tb', color_primary: null, status: 'active', icons_version: null },
  };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/rpc/portal_info')) return Response.json(tenants[JSON.parse(init.body).p_slug] ?? null);
    if (u === 'https://app.example/index.html') return new Response('<html><head><title>Portaria Prime</title><meta name="theme-color" content="#101F30" /><meta name="apple-mobile-web-app-title" content="Portaria Prime" /><link rel="apple-touch-icon" href="/apple-touch-icon-180x180.png" /><link rel="manifest" href="/manifest.webmanifest"></head></html>');
    throw new Error(u);
  };
  const get = (path) => GET(new Request(`https://app.example${path}`));
  try {
    const a = await (await get('/api/portal/manifest?slug=cond-a')).json();
    assert.deepEqual([a.id, a.scope, a.start_url, a.display], ['/c/cond-a/', '/c/cond-a/', '/c/cond-a/', 'standalone']);
    assert.equal(a.name, 'Residencial <A>');
    assert.equal(a.theme_color, '#126B61');
    assert.match(a.icons[0].src, /tenant-public\/ta\/app-v1700000000000\/icon-192\.png$/);
    assert.equal(a.icons[2].purpose, 'maskable');
    const b = await (await get('/api/portal/manifest?slug=cond-b')).json();
    assert.equal(b.id, '/c/cond-b/'); assert.equal(b.theme_color, '#101F30'); assert.match(b.icons[0].src, /^https:\/\/app\.example\/pwa-192x192\.png$/);
    assert.equal((await get('/api/portal/manifest?slug=nao-existe')).status, 404);
    assert.equal((await get('/api/portal/manifest?slug=../x')).status, 404);
    const html = await (await get('/api/portal/page?slug=cond-a')).text();
    assert.match(html, /<title>Residencial &lt;A&gt; — Portaria<\/title>/);
    assert.match(html, /<link rel="manifest" href="\/c\/cond-a\/manifest\.webmanifest" \/>/);
    assert.match(html, /content="#126B61"/);
    // Desconhecido: shell padrão (o app mostra "condomínio não encontrado"), sem marca de outro.
    const none = await (await get('/api/portal/page?slug=nao-existe')).text();
    assert.match(none, /href="\/manifest\.webmanifest"/);
    const info = await (await get('/api/portal/info?slug=cond-a')).json();
    assert.equal(info.tenant_id, undefined);
  } finally {
    globalThis.fetch = fetch0;
    for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'APP_URL']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
