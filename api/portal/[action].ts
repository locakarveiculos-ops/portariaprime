/**
 * Portal público do condomínio (sem sessão; só marca).
 *   GET /api/portal/manifest?slug=  -> Web App Manifest do condomínio (id/scope/start_url = /c/{slug}/)
 *   GET /api/portal/page?slug=      -> index.html com título, ícones, tema e manifest do condomínio
 * vercel.json reescreve /c/{slug}/manifest.webmanifest e /c/{slug}[/...] para estas rotas.
 * Slug desconhecido: 404, nunca o primeiro condomínio.
 */
import { handler, json, HttpError } from '../_lib/http.js';
import { serviceClient } from '../_lib/supabase.js';
import { appUrl, envAny } from '../_lib/env.js';
import { esc } from '../_lib/templates.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
let shell: { html: string; at: number } | null = null;

async function info(slug: string | null) {
  if (!slug || !SLUG.test(slug)) return null;
  const { data } = await serviceClient().rpc('portal_info', { p_slug: slug });
  return data && data.status === 'active' ? data : null;
}

function icons(base: string, i: any) {
  const pub = `${envAny('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '')}/storage/v1/object/public/tenant-public`;
  const v = i.icons_version;
  return v ? {
    i192: `${pub}/${i.tenant_id}/app-v${v}/icon-192.png`, i512: `${pub}/${i.tenant_id}/app-v${v}/icon-512.png`,
    mask: `${pub}/${i.tenant_id}/app-v${v}/maskable-512.png`, apple: `${pub}/${i.tenant_id}/app-v${v}/apple-180.png`,
  } : { i192: `${base}/pwa-192x192.png`, i512: `${base}/pwa-512x512.png`, mask: `${base}/maskable-icon-512x512.png`, apple: `${base}/apple-touch-icon-180x180.png` };
}

export const GET = handler(async (request) => {
  const url = new URL(request.url);
  const action = url.pathname.split('/').pop();
  const slug = url.searchParams.get('slug');
  const base = appUrl();

  if (action === 'manifest') {
    const i = await info(slug);
    if (!i) throw new HttpError(404, 'Condomínio não encontrado.');
    const ic = icons(base, i);
    const color = /^#[0-9A-Fa-f]{6}$/.test(i.color_primary || '') ? i.color_primary : '#101F30';
    const name = String(i.name).slice(0, 60);
    return new Response(JSON.stringify({
      // id estável por condomínio (slug é imutável na 1ª entrega); escopo isola o app do portal principal.
      id: `/c/${i.slug}/`, name, short_name: name.length > 12 ? name.split(/\s+/).slice(0, 2).join(' ').slice(0, 12) : name,
      description: `Encomendas do ${name}. Tecnologia Portaria Prime.`,
      start_url: `/c/${i.slug}/`, scope: `/c/${i.slug}/`, display: 'standalone', lang: 'pt-BR',
      theme_color: color, background_color: color,
      icons: [
        { src: ic.i192, sizes: '192x192', type: 'image/png' },
        { src: ic.i512, sizes: '512x512', type: 'image/png' },
        { src: ic.mask, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    }), { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=300' } });
  }

  if (action === 'page') {
    // Shell do SPA (mesmo build); só o <head> muda por condomínio.
    if (!shell || Date.now() - shell.at > 300_000) {
      const r = await fetch(`${base}/index.html`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new HttpError(502, 'Aplicativo indisponível.');
      shell = { html: await r.text(), at: Date.now() };
    }
    const i = await info(slug);
    if (!i) return new Response(shell.html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    const ic = icons(base, i);
    const color = /^#[0-9A-Fa-f]{6}$/.test(i.color_primary || '') ? i.color_primary : '#101F30';
    const name = esc(String(i.name).slice(0, 80));
    const html = shell.html
      .replace(/<title>[^<]*<\/title>/, `<title>${name} — Portaria</title>`)
      .replace(/<meta name="theme-color"[^>]*>/, `<meta name="theme-color" content="${color}" />`)
      .replace(/<meta name="apple-mobile-web-app-title"[^>]*>/, `<meta name="apple-mobile-web-app-title" content="${name}" />`)
      .replace(/<link rel="apple-touch-icon"[^>]*>/, `<link rel="apple-touch-icon" href="${esc(ic.apple)}" />`)
      .replace(/<link rel="manifest"[^>]*>/, `<link rel="manifest" href="/c/${i.slug}/manifest.webmanifest" />`);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=60' } });
  }

  if (action === 'info') {
    const i = await info(slug);
    if (!i) throw new HttpError(404, 'Condomínio não encontrado.');
    const { tenant_id: _t, ...pub } = i;
    return json(pub);
  }
  throw new HttpError(404, 'Ação desconhecida.');
});
