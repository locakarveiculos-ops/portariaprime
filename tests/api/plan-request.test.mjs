// /api/plan-request: pedido de contratação da página /planos. Preço sempre do catálogo ativo,
// nunca do navegador; exige concordância e hash do contrato exibido; honeypot e validações.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
const inserted = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const json = (b, status = 200, headers = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } });
  if (u.pathname === '/rest/v1/plans') return json(u.searchParams.get('code') === 'eq.prime' ? { id: 'p1', name: 'Prime', code: 'prime', published: true, is_custom: false } : null);
  if (u.pathname === '/rest/v1/plan_prices') return json(u.searchParams.get('cycle') === 'eq.yearly' ? { amount_cents: 355900, version: 2 } : null);
  if (u.pathname === '/rest/v1/contact_requests' && (init.method || 'GET') === 'HEAD') return new Response(null, { status: 200, headers: { 'content-range': '*/0' } });
  if (u.pathname === '/rest/v1/contact_requests') { inserted.push(JSON.parse(init.body)); return new Response('', { status: 201 }); }
  return json({ message: 'inesperado ' + u.pathname }, 500);
};
const { POST } = await import('../../api/public/[action].ts');
const sha = 'a'.repeat(64);
const base = { plan: 'prime', cycle: 'yearly', condoName: 'Residencial Teste', repName: 'Pessoa Teste', repRole: 'Síndica', repEmail: 'teste@example.invalid',
  agree: true, documentSha256: sha, documentVersion: '0.1-rascunho', amount_cents: 1 };
const req = (body) => new Request('http://x/api/plan-request?a=plan-request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('grava pedido com preço do catálogo, ignorando valor enviado pelo navegador', async () => {
  const r = await POST(req(base));
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.match(b.protocol, /^PC-\d{8}-[0-9A-F]{6}$/);
  assert.equal(b.amount_cents, 355900);
  const row = inserted.at(-1);
  assert.equal(row.source, 'planos:contrato');
  assert.match(row.message, /R\$\s?3\.559,00 por ciclo/);
  assert.match(row.message, /Não é aceite contratual/);
  assert.match(row.message, new RegExp(sha));
});

test('exige concordância, hash do contrato, campos e plano válido', async () => {
  for (const [patch, status] of [[{ agree: false }, 400], [{ documentSha256: 'x' }, 400], [{ repEmail: 'sem-arroba' }, 400], [{ plan: 'inexistente' }, 400],
    [{ cycle: 'monthly' }, 400], [{ cnpj: '123' }, 400], [{ cycle: 'semanal' }, 400]]) {
    const r = await POST(req({ ...base, ...patch }));
    assert.equal(r.status, status, JSON.stringify(patch));
  }
});

test('honeypot não grava', async () => {
  const n = inserted.length;
  const r = await POST(req({ ...base, website: 'bot' }));
  assert.equal(r.status, 200);
  assert.equal(inserted.length, n);
});
