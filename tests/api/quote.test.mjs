// /api/quote: tipo do anexo pela assinatura de bytes, tamanho, honeypot, limite por IP e campos.
// Intercepta o fetch do supabase-js (RPC + Storage) para ver o que seria gravado.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
const calls = [];
let limited = false;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ u, body: typeof init.body === 'string' ? init.body : null });
  if (u.endsWith('/rpc/quote_submit')) {
    return limited ? Response.json({ code: 'P0001', message: 'Recebemos suas solicitações. Aguarde nosso retorno.' }, { status: 400 })
      : Response.json({ id: '11111111-2222-4333-8444-555555555555', protocol: 'PP-ORC-20261023-ABCDEF' });
  }
  if (u.includes('/storage/v1/object/quote-attachments/')) return Response.json({ Key: 'x' });
  if (u.endsWith('/rpc/quote_attach')) return new Response(null, { status: 204 });
  throw new Error(`inesperado ${u}`);
};
const { POST } = await import('../../api/public/[action].ts');
const { sniff, MAX_FILE } = await import('../../api/public/_quote.ts');

const PDF = new TextEncoder().encode('%PDF-1.7\n%...');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const base = { contact_name: 'Ana', email: 'Ana@Cond.invalid', org_kind: 'condominio', org_name: 'Residencial Azul', units: '120',
  budget_cents: '18000', budget_cycle: 'monthly' };
const req = (fields, file, ip = '1.1.1.1') => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  if (file) f.set('attachment', new Blob([file.bytes], { type: file.type }), file.name);
  return new Request('http://x/api/quote?a=quote', { method: 'POST', body: f, headers: { 'x-forwarded-for': ip } });
};
const rpcCalls = (name) => calls.filter((c) => c.u.endsWith(`/rpc/${name}`));

test('assinatura de bytes: PDF/PNG/JPEG aceitos; extensão não basta', () => {
  assert.equal(sniff(PDF).mime, 'application/pdf');
  assert.equal(sniff(PNG).mime, 'image/png');
  assert.equal(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).mime, 'image/jpeg');
  assert.equal(sniff(new TextEncoder().encode('<svg onload=alert(1)>')), null);
  assert.equal(sniff(new TextEncoder().encode('MZ executável')), null);
});

test('envio válido com anexo: grava solicitação, sobe no bucket privado e registra hash', async () => {
  calls.length = 0;
  const r = await POST(req(base, { bytes: PDF, type: 'application/pdf', name: 'orcamento.pdf' }));
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { ok: true, protocol: 'PP-ORC-20261023-ABCDEF', attachment: 'saved' });
  const sub = JSON.parse(rpcCalls('quote_submit')[0].body);
  assert.equal(sub.p.email, 'ana@cond.invalid');
  assert.equal(sub.p.budget_cents, 18000);
  assert.match(sub.p_ip_hash, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(sub), /1\.1\.1\.1/);
  const att = JSON.parse(rpcCalls('quote_attach')[0].body);
  assert.equal(att.p_mime, 'application/pdf');
  assert.match(att.p_path, /^11111111-2222-4333-8444-555555555555\/[0-9a-f-]{36}\.pdf$/);
  assert.ok(calls.some((c) => c.u.includes('/storage/v1/object/quote-attachments/')));
});

test('anexo com tipo falso é recusado antes de gravar qualquer coisa', async () => {
  calls.length = 0;
  const r = await POST(req(base, { bytes: new TextEncoder().encode('<html>'), type: 'application/pdf', name: 'falso.pdf' }));
  assert.equal(r.status, 415);
  assert.equal(calls.length, 0);
});

test('anexo acima de 5 MB é recusado', async () => {
  calls.length = 0;
  const big = new Uint8Array(MAX_FILE + 1); big.set(PDF);
  const r = await POST(req(base, { bytes: big, type: 'application/pdf', name: 'grande.pdf' }));
  assert.equal(r.status, 413);
  assert.equal(calls.length, 0);
});

test('honeypot finge sucesso sem gravar', async () => {
  calls.length = 0;
  const r = await POST(req({ ...base, website: 'http://spam' }, { bytes: PDF, type: 'application/pdf', name: 'a.pdf' }));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
});

test('campos inválidos e limite por IP', async () => {
  calls.length = 0;
  assert.equal((await POST(req({ ...base, email: 'sem-arroba' }))).status, 400);
  assert.equal((await POST(req({ ...base, units: '12.5' }))).status, 400);
  assert.equal((await POST(req({ ...base, budget_cycle: '' }))).status, 400, 'valor sem periodicidade');
  assert.equal(calls.length, 0);
  limited = true;
  const r = await POST(req(base));
  assert.equal(r.status, 429);
  limited = false;
  assert.equal((await POST(new Request('http://x/api/quote?a=quote', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }))).status, 415);
});
