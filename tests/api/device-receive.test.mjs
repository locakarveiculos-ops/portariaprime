import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../../api/totem/[action].ts';

test('recebimento sem login usa credencial do dispositivo e retorna só local, sem dados privados', async () => {
  const previous = { ...process.env }; const fetch = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'fixture' });
  let called = 0;
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/rpc\/device_receive$/);
    const body = JSON.parse(init.body);
    assert.equal(body.p_unit, '11111111-1111-4111-8111-111111111111');
    assert.equal(body.p_tenant, undefined);
    assert.match(body.p_secret_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(body.p_secret_hash, 'a'.repeat(64));
    called++;
    return Response.json({ ok: true, replayed: false, storage_code: 'A2', storage_rack: 'A', storage_shelf: '2', concierge_name: 'Central', resident_name: 'Não retornar', package_id: 'privado' });
  };
  const request = (unit, secret = 'a'.repeat(64)) => new Request('http://localhost/api/totem/receive', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-device-secret': secret },
    body: JSON.stringify({ unitId: unit, idempotencyKey: 'recebimento-1234', tenantId: 'forjado', carrier: 'Correios', trackingCode: 'BR123' }),
  });
  try {
    assert.equal((await POST(request(null))).status, 400);
    assert.equal((await POST(request('11111111-1111-4111-8111-111111111111', ''))).status, 401);
    assert.equal(called, 0);
    const response = await POST(request('11111111-1111-4111-8111-111111111111'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, replayed: false, storage_code: 'A2', storage_rack: 'A', storage_shelf: '2', concierge_name: 'Central' });
    assert.equal(called, 1);
  } finally {
    globalThis.fetch = fetch;
    for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});
