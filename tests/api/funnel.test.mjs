// /api/funnel: só eventos conhecidos, sem dados pessoais, nunca quebra a página.
// Intercepta o fetch do supabase-js para ver exatamente o que seria gravado.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('http://127.0.0.1:9/rest/v1/funnel_events')) { sent.push(JSON.parse(init.body)); return new Response('', { status: 201 }); }
  return realFetch(url, init);
};
const { POST } = await import('../../api/public/[action].ts');
const req = (body) => new Request('http://x/api/funnel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const visitor = '3f1b2c4d-1111-4222-8333-944455556666';

test('grava evento conhecido apenas com campos permitidos', async () => {
  const r = await POST(req({ event: 'cta_trial_click', visitor, plan: 'profissional', email: 'x@y.z', name: 'Fulano', utm_source: 'google' }));
  assert.equal(r.status, 204);
  const row = [sent.at(-1)].flat()[0];
  assert.deepEqual(Object.keys(row).sort(), ['event', 'plan', 'utm_campaign', 'utm_source', 'visitor']);
  assert.equal(row.utm_campaign, null);
});

test('ignora evento desconhecido ou visitante com dado pessoal, sem erro', async () => {
  const n = sent.length;
  assert.equal((await POST(req({ event: 'drop_table', visitor }))).status, 204);
  assert.equal((await POST(req({ event: 'landing_view', visitor: 'eu@email.com' }))).status, 204);
  assert.equal(sent.length, n);
});

test('falha do banco não quebra a resposta', async () => {
  globalThis.fetch = async () => new Response('{"message":"x"}', { status: 500 });
  assert.equal((await POST(req({ event: 'landing_view', visitor }))).status, 204);
});
