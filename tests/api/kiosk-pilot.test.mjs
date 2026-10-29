// /api/public/kiosk-pilot: "Solicitar ativação piloto" do Modo Portaria Exclusiva. Grava antes de confirmar,
// valida campos, exige confirmação de aparelho dedicado, honeypot e limite por IP. Textos comerciais sem promessas proibidas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
const inserted = [];
let recent = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.pathname === '/rest/v1/contact_requests' && (init.method || 'GET') === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${recent}` } });
  if (u.pathname === '/rest/v1/contact_requests') { inserted.push(JSON.parse(init.body)); return new Response('', { status: 201 }); }
  return new Response(JSON.stringify({ message: 'inesperado ' + u.pathname }), { status: 500 });
};
const { POST } = await import('../../api/public/[action].ts');
const base = { condoName: 'Residencial Teste', name: 'Pessoa Teste', role: 'Síndica', email: 'Teste@Example.invalid', phone: '(11) 98888-7777',
  brand: 'Samsung', model: 'Galaxy Tab A9', android: '14', devices: 2, notes: 'Guarita', dedicated: true };
const req = (body) => new Request('http://x/api/public/kiosk-pilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('grava solicitação com protocolo e dados técnicos', async () => {
  const r = await POST(req(base));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.match(b.protocol, /^PQ-\d{8}-[0-9A-F]{6}$/);
  const row = inserted.at(-1);
  assert.equal(row.source, 'quiosque:piloto');
  assert.equal(row.email, 'teste@example.invalid');
  assert.equal(row.phone, '11988887777');
  assert.match(row.message, /Samsung Galaxy Tab A9 · Android 14 · 2 aparelho/);
  assert.match(row.message, /validação de compatibilidade/);
  assert.ok(row.message.includes(b.protocol));
});

test('validação: campos, versão do Android, quantidade e confirmação de aparelho dedicado', async () => {
  for (const patch of [{ dedicated: false }, { email: 'x' }, { brand: '' }, { model: '' }, { android: '7' }, { devices: 0 }, { devices: 21 }, { condoName: 'x' }, { phone: '123' }]) {
    const r = await POST(req({ ...base, ...patch }));
    assert.equal(r.status, 400, JSON.stringify(patch));
  }
});

test('honeypot não grava; limite por IP devolve 429', async () => {
  const n = inserted.length;
  assert.equal((await POST(req({ ...base, website: 'bot' }))).status, 200);
  assert.equal(inserted.length, n);
  recent = 3;
  assert.equal((await POST(req(base))).status, 429);
  assert.equal(inserted.length, n);
  recent = 0;
});

test('textos do recurso: obrigatórios presentes e sem promessas proibidas', async () => {
  const { KIOSK } = await import('../../src/lib/kiosk-offer.ts');
  const { readFileSync } = await import('node:fs');
  assert.equal(KIOSK.requirement, 'O modo quiosque exige dispositivo Android compatível, dedicado à portaria, e configuração inicial. Equipamento não incluso.');
  assert.equal(KIOSK.feature, 'Modo Portaria Exclusiva para Android*');
  assert.equal(KIOSK.cta, 'Solicitar ativação piloto');
  const landing = readFileSync('src/pages/LandingPage.tsx', 'utf8');
  for (const t of ['Um dispositivo dedicado à portaria. Mais foco na operação.', 'Começar meu mês grátis', 'Ver como funciona', 'restauração de fábrica', 'Demonstração em emulador'])
    assert.ok(landing.includes(t), t);
  const all = [landing, readFileSync('src/lib/kiosk-offer.ts', 'utf8'), readFileSync('src/lib/help.ts', 'utf8'), readFileSync('src/lib/tutorials.ts', 'utf8'), readFileSync('docs/legal/contrato-saas.md', 'utf8')].join('\n');
  // "Funciona em qualquer Android?" é pergunta do FAQ (resposta "Não"); proibida é a afirmação.
  assert.doesNotMatch(all.replace(/Funciona em qualquer Android\?', 'Não\./g, ''), /imposs[ií]vel sair|100% inviol|qualquer (aparelho|android|celular)|seguran[çc]a total|menor pre[çc]o|rastreamento/i);
  assert.doesNotMatch(all, /PWA[^.]*(?<!não )bloqueia o aparelho/, 'PWA nunca bloqueia o aparelho');
});
