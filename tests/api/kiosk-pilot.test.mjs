// /api/public/kiosk-pilot: "Solicitar ativação piloto" do Modo Portaria Exclusiva. Grava antes de confirmar,
// valida campos, exige confirmação de aparelho dedicado, honeypot, limite por IP e reenvio idêntico sem duplicar.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
// Tabela contact_requests em memória (PostgREST: HEAD = contagem, GET = filtros eq/gte, POST = insert com defaults).
const rows = [];
const inserted = rows;
let recent = 0, failInsert = false, failSelect = false;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const method = init.method || 'GET';
  if (u.pathname !== '/rest/v1/contact_requests') return new Response(JSON.stringify({ message: 'inesperado ' + u.pathname }), { status: 500 });
  if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': `*/${recent}` } });
  if (method === 'GET') {
    if (failSelect) return new Response(JSON.stringify({ message: 'banco indisponível' }), { status: 503 });
    let out = rows.slice();
    for (const [k, v] of u.searchParams) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const [op, val] = [v.slice(0, v.indexOf('.')), v.slice(v.indexOf('.') + 1)];
      out = out.filter((r) => (op === 'eq' ? String(r[k]) === val : op === 'gte' ? r[k] >= val : false));
    }
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return new Response(JSON.stringify(out.slice(0, Number(u.searchParams.get('limit') || 1000))), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (failInsert) return new Response(JSON.stringify({ message: 'falha ao gravar' }), { status: 500, headers: { 'content-type': 'application/json' } });
  rows.push({ created_at: new Date().toISOString(), ...JSON.parse(init.body) });
  return new Response('', { status: 201 });
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
  assert.equal((await POST(req({ ...base, email: 'outra@example.invalid' }))).status, 429);
  assert.equal(inserted.length, n);
  recent = 0;
});

test('persistência: uma linha com source, sem status forçado (default "novo" do banco), e-mail normalizado e protocolo na mensagem', async () => {
  rows.length = 0;
  const b = await (await POST(req({ ...base, email: 'nova@example.invalid' }))).json();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'quiosque:piloto');
  assert.equal(rows[0].status, undefined, 'API não define status: o default do banco é "novo" (tests/db/kiosk-pricing.test.mjs)');
  assert.ok(rows[0].ip_hash && !rows[0].ip_hash.includes('.'), 'só hash do IP');
  assert.ok(rows[0].message.startsWith(`Solicitação de ativação piloto ${b.protocol}`));
});

test('erro do banco devolve erro e não confirma protocolo', async () => {
  rows.length = 0;
  failInsert = true;
  const r = await POST(req({ ...base, email: 'erro@example.invalid' }));
  failInsert = false;
  assert.equal(r.status, 500);
  const b = await r.json();
  assert.equal(b.protocol, undefined);
  assert.equal(rows.length, 0);
  failSelect = true;
  const r2 = await POST(req({ ...base, email: 'erro@example.invalid' }));
  failSelect = false;
  assert.equal(r2.status, 500, 'falha na checagem de duplicidade também não confirma');
  assert.equal(rows.length, 0);
});

test('reenvio idêntico em 30 min devolve o mesmo protocolo sem nova linha; outro aparelho, outro e-mail ou após 30 min criam nova', async () => {
  rows.length = 0;
  const first = await (await POST(req(base))).json();
  const again = await (await POST(req({ ...base, email: 'TESTE@example.invalid', condoName: 'residencial  teste', notes: 'outra obs' }))).json();
  assert.equal(again.protocol, first.protocol);
  assert.equal(again.duplicate, true);
  assert.equal(rows.length, 1);
  // Outro modelo: nova solicitação.
  const other = await (await POST(req({ ...base, model: 'Galaxy Tab A8' }))).json();
  assert.notEqual(other.protocol, first.protocol);
  assert.equal(rows.length, 2);
  // Outra pessoa com o mesmo condomínio/aparelho não recebe o protocolo de ninguém.
  const stranger = await (await POST(req({ ...base, email: 'intrusa@example.invalid' }))).json();
  assert.ok(![first.protocol, other.protocol].includes(stranger.protocol));
  assert.equal(stranger.duplicate, undefined);
  assert.equal(rows.length, 3);
  // Depois de 30 min, mesmo pedido gera novo protocolo.
  for (const r of rows) r.created_at = new Date(Date.now() - 31 * 60_000).toISOString();
  const later = await (await POST(req(base))).json();
  assert.notEqual(later.protocol, first.protocol);
  assert.equal(rows.length, 4);
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
