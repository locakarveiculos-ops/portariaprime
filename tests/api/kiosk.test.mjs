// /api/totem/kiosk-*: inscrição com prova de posse da chave, requisições assinadas (ECDSA P-256),
// corpo adulterado, chave de outro aparelho e repasse do contador ao banco (anti-replay lá).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';

process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
const calls = [];
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = (k) => k.export({ format: 'der', type: 'spki' }).toString('base64');
const DEV = randomUUID();
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const fn = u.pathname.replace('/rest/v1/rpc/', '');
  const body = init.body ? JSON.parse(init.body) : {};
  calls.push({ fn, body });
  const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (fn === 'mdm_agent_enroll') return json({ device_id: DEV, device_name: 'Tablet', tenant_slug: 'cond' });
  if (fn === 'mdm_agent_key') return json(body.p_device === DEV ? { public_key: spki(publicKey), last_counter: 0, state: 'active' } : null);
  if (fn === 'mdm_agent_sync') return json({ policy: { version_id: 'v1' }, commands: [] });
  if (fn === 'mdm_agent_ack') return json({ status: body.p_status, replayed: false });
  return new Response(JSON.stringify({ message: 'inesperado ' + fn }), { status: 500 });
};
const { POST } = await import('../../api/totem/[action].ts');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64sig = (key, msg) => sign('sha256', Buffer.from(msg), { key, dsaEncoding: 'der' }).toString('base64');

function signed(path, body, { counter = 1, key = privateKey, device = DEV, tamper = null } = {}) {
  const text = JSON.stringify(body);
  const sig = b64sig(key, `POST\n${path}\n${device}\n${counter}\n${sha(text)}`);
  return new Request(`http://x${path}`, { method: 'POST', body: tamper ?? text,
    headers: { 'content-type': 'application/json', 'x-pp-device': device, 'x-pp-counter': String(counter), 'x-pp-signature': sig } });
}

test('inscrição exige prova de posse da chave P-256 e token no formato', async () => {
  const token = 'ABCDEF0123456789ABCDEF01';
  const agentId = randomUUID();
  const base = { token, agentId, publicKey: spki(publicKey), info: { managed: true, sdk: 34, model: 'X' } };
  const req = (b) => new Request('http://x/api/totem/kiosk-enroll', { method: 'POST', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
  assert.equal((await POST(req({ ...base, proof: b64sig(other.privateKey, `enroll\n${token}\n${agentId}`) }))).status, 401);
  assert.equal((await POST(req({ ...base, token: 'curto', proof: 'x' }))).status, 400);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal((await POST(req({ ...base, publicKey: rsa, proof: 'x' }))).status, 400);
  const r = await POST(req({ ...base, proof: b64sig(privateKey, `enroll\n${token}\n${agentId}`) }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tenantSlug, 'cond');
  const call = calls.findLast((c) => c.fn === 'mdm_agent_enroll');
  assert.equal(call.body.p_token_hash, sha(token));
  assert.ok(!JSON.stringify(call.body).includes(token), 'token em texto não vai ao banco');
});

test('sync assinado passa; adulterado, chave errada, aparelho desconhecido e cabeçalho ausente não', async () => {
  const path = '/api/totem/kiosk-sync';
  const ok = await POST(signed(path, { report: { managed: true } }, { counter: 5 }));
  assert.equal(ok.status, 200);
  assert.equal(calls.findLast((c) => c.fn === 'mdm_agent_sync').body.p_counter, 5);
  assert.equal((await POST(signed(path, { report: {} }, { tamper: JSON.stringify({ report: { managed: false } }) }))).status, 401);
  assert.equal((await POST(signed(path, { report: {} }, { key: other.privateKey }))).status, 401);
  assert.equal((await POST(signed(path, { report: {} }, { device: randomUUID() }))).status, 401);
  assert.equal((await POST(new Request(`http://x${path}`, { method: 'POST', body: '{}' }))).status, 401);
  // Assinatura de outra rota não serve para esta.
  const s = signed('/api/totem/kiosk-ack', { commandId: randomUUID(), status: 'applied' });
  assert.equal((await POST(new Request(`http://x${path}`, { method: 'POST', body: await s.text(), headers: s.headers }))).status, 401);
});

test('ack valida comando e repassa estado', async () => {
  const path = '/api/totem/kiosk-ack';
  assert.equal((await POST(signed(path, { commandId: 'x', status: 'applied' }))).status, 400);
  const r = await POST(signed(path, { commandId: randomUUID(), status: 'applied', detail: 'ok' }, { counter: 9 }));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'applied');
});
