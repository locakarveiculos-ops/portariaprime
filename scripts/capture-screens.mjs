// Capturas REAIS para landing/ajuda: navegador de verdade, stack Supabase local isolada, operações executadas.
// Dois condomínios fictícios com marcas diferentes; QR da tela do morador é desfocado (não utilizável);
// assinatura é um traço sintético. Originais PNG em tests/evidence/screens (fora do Git),
// WebP otimizados em public/screens. Manifesto: docs/SCREENSHOTS_MANIFEST.md.
//
//   node scripts/local-stack.mjs up
//   npm run dev:stack  (Vite em 3017 + API em 3019 com .env.stack.local)
//   node --env-file=.env.stack.local scripts/capture-screens.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { assertLocalSupabase } from '../tests/e2e/environment.mjs';

const APP = process.env.APP || 'http://127.0.0.1:3017';
const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: secret } = process.env;
assertLocalSupabase(url);
const svc = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const run = Date.now().toString(36);
const raw = 'tests/evidence/screens';
const out = 'public/screens';
await mkdir(raw, { recursive: true });
await mkdir(out, { recursive: true });
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const manifest = [];

await svc.from('plans').update({ published: true }).in('code', ['essencial', 'profissional', 'prime', 'sob-medida']);

async function account(key) {
  const email = `demo-${run}-${key}@demo.portariaprime.invalid`;
  const password = `D${crypto.randomUUID()}!`;
  const { error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: key.replace(/^\w/, (c) => c.toUpperCase()) } });
  if (error) throw error;
  return { email, password };
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = (vp, mobile = false) => browser.newContext({ viewport: vp, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
async function login(page, who) {
  await page.goto(`${APP}/entrar`);
  await page.getByLabel('E-mail', { exact: true }).fill(who.email);
  await page.getByLabel('Senha', { exact: true }).fill(who.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL(/\/app|\/c\//);
}
async function shot(page, name, route, scenario, blur = []) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.evaluate(() => document.fonts?.ready);
  // Esconde ofertas de tutorial/toasts para a captura mostrar a tela em si.
  await page.addStyleTag({ content: '[aria-live="polite"] > * { display: none !important; } main > div:has(> a[href*="ajuda?artigo"]) { display: none !important; }' });
  const png = await page.screenshot({ fullPage: false });
  let img = sharp(png);
  if (blur.length) {
    const meta = await img.metadata();
    const overlays = [];
    for (const sel of blur) {
      const b = await page.locator(sel).first().boundingBox();
      if (b) overlays.push({ input: await sharp(png).extract({ left: Math.max(0, Math.round(b.x)), top: Math.max(0, Math.round(b.y)), width: Math.min(meta.width - Math.round(b.x), Math.round(b.width)), height: Math.min(meta.height - Math.round(b.y), Math.round(b.height)) }).blur(18).toBuffer(), left: Math.max(0, Math.round(b.x)), top: Math.max(0, Math.round(b.y)) });
    }
    img = sharp(await img.composite(overlays).png().toBuffer());
  }
  const final = await img.png().toBuffer();
  await writeFile(`${raw}/${name}.png`, final);
  await sharp(final).webp({ quality: 82 }).toFile(`${out}/${name}.webp`);
  if (page.viewportSize().width > 720) await sharp(final).resize(720).webp({ quality: 80 }).toFile(`${out}/${name}-720.webp`);
  const vp = page.viewportSize();
  manifest.push({ file: `public/screens/${name}.webp`, route, viewport: `${vp.width}x${vp.height}`, scenario });
  console.log(`• ${name}`);
}

async function setupTenant(s, { name, slug, color, doc }) {
  await s.getByRole('button', { name: 'Cadastrar condomínio' }).click();
  await s.getByLabel('Nome do condomínio').fill(name);
  await s.getByLabel(/Endereço no sistema/).fill(slug);
  await s.getByLabel(/CNPJ do condomínio/).fill(doc);
  await s.getByRole('button', { name: 'Ativar mês grátis' }).click();
  await s.waitForURL(new RegExp(`/c/${slug}/configuracoes`));
  await s.getByLabel('Primária').fill(color);
  await s.getByRole('button', { name: 'Salvar' }).first().click();
  await s.getByText('Marca salva.').waitFor();
  for (const [code, cap] of [['Estante A', '12'], ['Estante B', '12'], ['Sala de volumes', '6']]) {
    await s.getByLabel('Código').fill(code);
    await s.getByLabel('Capacidade').fill(cap);
    await s.getByRole('button', { name: 'Adicionar' }).click();
    await s.locator('[data-tour="config-locais"] li', { hasText: `${code} · capacidade` }).waitFor();
  }
  await s.goto(`${APP}/c/${slug}/pessoas`);
  for (const [i, [b, u]] of [['A', '101'], ['A', '102'], ['A', '201'], ['B', '101'], ['B', '305']].entries()) {
    await s.getByLabel('Bloco/Torre (opcional)').fill(b);
    await s.getByLabel('Unidade', { exact: true }).fill(u);
    await s.getByRole('button', { name: 'Adicionar' }).click();
    await s.getByText(new RegExp(`Unidades \\(${i + 1} ativas`)).waitFor();
  }
}
async function invite(s, button, email) {
  await s.getByRole('button', { name: button }).first().click();
  await s.getByLabel('E-mail da pessoa').fill(email);
  await s.getByRole('button', { name: 'Enviar convite' }).click();
  const field = s.locator('input[readonly]');
  await field.waitFor();
  const link = await field.inputValue();
  await s.getByRole('button', { name: 'Fechar' }).click();
  return link;
}
async function accept(c, link, who) {
  const p = await c.newPage();
  await login(p, who);
  await p.goto(link);
  await p.getByRole('button', { name: 'Aceitar convite' }).click();
  await p.waitForURL(/\/c\//);
  return p;
}
async function receive(p, slug, unit, tracking, carrier, recipient) {
  await p.goto(`${APP}/c/${slug}/portaria`);
  await p.getByLabel(/Unidade de destino/).fill(unit);
  await p.getByRole('listbox', { name: 'Unidades encontradas' }).getByRole('option').first().click();
  await p.getByLabel('Transportadora').selectOption(carrier);
  await p.getByLabel(/Rastreio/).fill(tracking);
  await p.getByLabel(/Destinatário/).fill(recipient);
  await p.getByRole('button', { name: 'Registrar encomenda' }).click();
  await p.getByText(/Encomenda registrada para/).waitFor();
}

try {
  const A = { name: 'Residencial Aurora', slug: `e2e-aurora-${run}`, color: '#1F3A5F', doc: String(11_000_000_000_000 + (Date.now() % 9_000_000_000)) };
  const B = { name: 'Condomínio Jardim das Palmeiras', slug: `e2e-jardim-${run}`, color: '#126B61', doc: String(22_000_000_000_000 + (Date.now() % 9_000_000_000)) };
  const sindA = await account('síndica aurora'.replace(/\W+/g, '-')), sindB = await account('sindico-jardim');
  const port = await account('porteiro-aurora'), mor = await account('moradora-aurora');

  const dA = await ctx({ width: 1440, height: 900 });
  const s = await dA.newPage();
  await login(s, sindA);
  await setupTenant(s, A);
  await s.goto(`${APP}/c/${A.slug}/pessoas`);
  const linkP = await invite(s, 'Convidar equipe', port.email);
  const linkM = await invite(s, 'Convidar morador', mor.email);

  const dP = await ctx({ width: 1440, height: 900 });
  const p = await accept(dP, linkP, port);
  const mobM = await ctx({ width: 390, height: 844 }, true);
  const m = await accept(mobM, linkM, mor);

  const items = [['A 101', 'Correios', 'Moradora Aurora'], ['A 101', 'Mercado Livre', 'Moradora Aurora'], ['A 102', 'Amazon', 'Carlos Demo'], ['A 201', 'Shopee', 'Ana Demo'],
    ['B 101', 'Loggi', 'Bruno Demo'], ['B 305', 'Correios', 'Paula Demo'], ['A 102', 'Correios', 'Carlos Demo']];
  for (const [i, [u, c, r]] of items.entries()) await receive(p, A.slug, u, `DEMO${run.toUpperCase()}${i}BR`, c, r);

  // Recebimento preenchido (antes de salvar) para a captura.
  await p.goto(`${APP}/c/${A.slug}/portaria`);
  await p.getByLabel(/Unidade de destino/).fill('A 201');
  await p.getByRole('listbox', { name: 'Unidades encontradas' }).getByRole('option').first().click();
  await p.getByLabel('Transportadora').selectOption('Mercado Livre');
  await p.getByLabel(/Rastreio/).fill('DEMO-ML-8841');
  await p.getByLabel(/Destinatário/).fill('Ana Demo');
  await shot(p, 'recebimento-desktop', '/c/:slug/portaria', 'Recebimento preenchido manualmente, antes de salvar');

  // Entrega com assinatura sintética e comprovante.
  await p.getByRole('tab', { name: 'Buscar' }).click();
  await p.getByRole('button', { name: 'Entregar sem QR' }).first().click();
  await p.getByLabel('Quem está retirando').fill('Moradora Aurora');
  await p.getByLabel('Justificativa').fill('Demonstração: QR apresentado em outro aparelho');
  const box = await p.locator('canvas').boundingBox();
  await p.mouse.move(box.x + 30, box.y + 60); await p.mouse.down();
  await p.mouse.move(box.x + 120, box.y + 30, { steps: 10 }); await p.mouse.move(box.x + 200, box.y + 80, { steps: 10 }); await p.mouse.move(box.x + 280, box.y + 40, { steps: 10 });
  await p.mouse.up();
  await p.getByRole('button', { name: 'Confirmar entrega' }).click();
  await p.getByRole('dialog', { name: 'Comprovante de retirada' }).getByText('Retirada por').waitFor();
  await shot(p, 'comprovante-desktop', '/c/:slug/portaria (comprovante)', 'Comprovante após retirada real com assinatura sintética');

  // Celular da portaria.
  const mobP = await ctx({ width: 390, height: 844 }, true);
  const pm = await mobP.newPage();
  await login(pm, port);
  await pm.goto(`${APP}/c/${A.slug}/portaria`);
  await pm.getByRole('tab', { name: 'Buscar' }).click();
  await pm.getByText(/Aguardando retirada/).waitFor();
  await shot(pm, 'portaria-mobile', '/c/:slug/portaria (Buscar)', 'Portaria no celular: aguardando retirada');

  // Morador: QR desfocado.
  await m.goto(`${APP}/c/${A.slug}/morador`);
  await m.getByText(/Para retirar \(\d+\)/).waitFor();
  await m.getByRole('button', { name: 'Mostrar QR de retirada' }).first().click();
  await m.getByText('Uso único').waitFor();
  await shot(m, 'morador-mobile', '/c/:slug/morador (QR)', 'Morador com QR de uso único (QR desfocado na captura)', ['[role="dialog"] svg.rounded-md']);

  // Painel, ocupação e assinatura.
  await s.goto(`${APP}/c/${A.slug}/painel`);
  await s.getByText('Retiradas no período').waitFor();
  await shot(s, 'painel-desktop', '/c/:slug/painel', 'Painel do síndico após 7 recebimentos e 1 retirada');
  await s.locator('[data-tour="painel-ocupacao"]').scrollIntoViewIfNeeded();
  await s.evaluate(() => scrollBy(0, -80));
  await shot(s, 'armazenamento-desktop', '/c/:slug/painel (ocupação)', 'Ocupação dos locais de guarda');
  await s.goto(`${APP}/c/${A.slug}/assinatura`);
  await s.getByText(/Mês grátis de/).waitFor();
  await shot(s, 'assinatura-desktop', '/c/:slug/assinatura', 'Mês grátis ativo com plano escolhido');
  await s.goto(`${APP}/c/${A.slug}/portaria`);
  await s.getByRole('tab', { name: 'Buscar' }).click();
  await shot(s, 'marca-a-desktop', '/c/:slug/portaria', 'Condomínio A com marca azul');

  // Condomínio B, outra marca.
  const dB = await ctx({ width: 1440, height: 900 });
  const sb = await dB.newPage();
  await login(sb, sindB);
  await setupTenant(sb, B);
  await receive(sb, B.slug, 'A 101', `DEMOB${run.toUpperCase()}BR`, 'Correios', 'Morador Jardim');
  await sb.getByRole('tab', { name: 'Buscar' }).click();
  await shot(sb, 'marca-b-desktop', '/c/:slug/portaria', 'Condomínio B com marca verde; dados separados de A');

  // Imagem Open Graph a partir do painel.
  await sharp(`${raw}/painel-desktop.png`).resize(1200, 630, { fit: 'cover', position: 'top' }).png({ compressionLevel: 9 }).toFile(`${out}/og.png`);

  const date = new Date().toISOString().slice(0, 10);
  const md = ['# Manifesto de capturas', '', `Geradas por \`scripts/capture-screens.mjs\` em ${date}, commit \`${commit}\` (mais alterações locais da sessão), stack Supabase local isolada (\`scripts/local-stack.mjs\`), Edge headless, tema claro, movimento reduzido.`,
    'Todos os dados são fictícios (domínio `.invalid`). QR da tela do morador desfocado; assinatura é traço sintético; tokens pertencem apenas à stack local.', '',
    '| Arquivo | Rota | Viewport | Cenário |', '|---|---|---|---|',
    ...manifest.map((x) => `| \`${x.file}\` | \`${x.route}\` | ${x.viewport} | ${x.scenario} |`), '| `public/screens/og.png` | derivada de painel-desktop | 1200x630 | Imagem Open Graph |', '',
    'Recapturar: subir a stack local, `npm run dev:stack` e `node --env-file=.env.stack.local scripts/capture-screens.mjs`.', ''];
  await writeFile('docs/SCREENSHOTS_MANIFEST.md', md.join('\n'));
  console.log(`PASS ${manifest.length} capturas.`);
} catch (e) {
  for (const c of browser.contexts()) for (const pg of c.pages()) await pg.screenshot({ path: `${raw}/falha-${c.pages().indexOf(pg)}-${browser.contexts().indexOf(c)}.png` }).catch(() => {});
  throw e;
} finally {
  await browser.close();
}
