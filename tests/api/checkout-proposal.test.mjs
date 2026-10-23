// /api/billing/checkout: usa prepare_proposal_billing (servidor decide proposta x catálogo);
// valor do link vem do pedido do banco, nunca do corpo da requisição.
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  APP_URL: 'https://app.example', INFINITEPAY_HANDLE: 'loja-teste' });
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ u, body });
  if (u.endsWith('/auth/v1/user')) return Response.json({ id: 'u1', email: 'g@x.invalid' });
  if (u.endsWith('/rpc/prepare_proposal_billing')) return Response.json({ order_id: 'o1', order_nsu: 'pp-1', amount_cents: 13000, description: 'Portaria Prime — Profissional (monthly)' });
  if (u.endsWith('/rpc/claim_checkout_link')) return Response.json({ claimed: true });
  if (u.endsWith('/rpc/finish_checkout_link')) return Response.json(true);
  if (u.includes('infinitepay')) return Response.json({ url: 'https://checkout.infinitepay.io/loja-teste/abc' });
  throw new Error(`inesperado ${u}`);
};
const { POST } = await import('../../api/billing/[action].ts');

test('checkout chama a RPC da ponte e usa o valor do pedido do servidor', async () => {
  const r = await POST(new Request('http://x/api/billing/checkout', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer jwt' },
    body: JSON.stringify({ tenantId: '11111111-2222-4333-8444-555555555555', amount_cents: 1 }) }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.ok(calls.some((c) => c.u.endsWith('/rpc/prepare_proposal_billing')));
  assert.ok(!calls.some((c) => c.u.endsWith('/rpc/prepare_checkout')), 'não chama a RPC antiga direto');
  const rpc = calls.find((c) => c.u.endsWith('/rpc/prepare_proposal_billing'));
  assert.deepEqual(Object.keys(rpc.body), ['p_tenant'], 'sem preço/plano/token vindos do navegador');
  const link = calls.find((c) => c.u.includes('infinitepay'));
  assert.match(JSON.stringify(link.body), /13000/);
  assert.doesNotMatch(JSON.stringify(link.body), /"price":1\b|"amount":1\b/);
});
