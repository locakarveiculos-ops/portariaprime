import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../../api/totem/[action].ts';

const request = (secret, imageBase64 = 'data:image/png;base64,AAAA') => new Request('http://localhost/api/totem/ocr', {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'X-Device-Secret': secret } : {}) },
  body: JSON.stringify({ imageBase64, tenantId: 'tenant-forjado' }),
});

test('OCR público usa dispositivo sem JWT; nega revogado/franquia; não retorna cadastros', async () => {
  const saved = { ...process.env }; const fetch = globalThis.fetch;
  Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'fixture', GEMINI_API_KEY: 'fixture' });
  let allowed = true, revoked = false, modelCalls = 0, recheck = false;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url.includes('/rpc/device_consume_ocr')) {
      assert.deepEqual(Object.keys(JSON.parse(init.body)), ['p_secret_hash']);
      return revoked ? Response.json({ code: '42501', message: 'Totem revogado.' }, { status: 403 }) : Response.json(allowed);
    }
    if (url.includes('/rpc/device_context')) {
      recheck = true;
      return revoked ? Response.json({ code: '42501', message: 'Totem revogado.' }, { status: 403 }) : Response.json({});
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      modelCalls++;
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ carrier: 'Correios', unit: '12B', block: 'A', trackingCode: 'BR123', confidence: 90,
        recipientName: 'Pessoa na etiqueta', senderName: 'Loja', evidence: [{ field: 'name', text: 'privado' }] }) }] } }] });
    }
    throw new Error(`Chamada inesperada: ${url}`);
  };
  try {
    assert.equal((await POST(request(null))).status, 401);
    assert.equal((await POST(request('a'.repeat(64), 'inválido'))).status, 400);
    revoked = true;
    assert.equal((await POST(request('a'.repeat(64)))).status, 403);
    revoked = false; allowed = false;
    assert.equal((await POST(request('a'.repeat(64)))).status, 402);
    assert.equal(modelCalls, 0);
    allowed = true;
    const result = await POST(request('a'.repeat(64)));
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { carrier: 'Correios', unit: '12B', block: 'A', trackingCode: 'BR123', confidence: 90 });
    assert.equal(recheck, true);
    assert.equal(modelCalls, 1);
    assert.ok(calls.every(url => !url.includes('match_recipient') && !url.includes('/auth/')));
  } finally {
    globalThis.fetch = fetch;
    for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'GEMINI_API_KEY']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
