// Exercita handlers reais por HTTP local. Sem credenciais ou rede externa.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../../scripts/dev-api.mjs';

test('runtime serve JSON de validação/autorização e não fallback HTML', async () => {
  const server = createApiServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const missingAuth = await fetch(`${base}/api/billing/order?id=00000000-0000-4000-8000-000000000000`);
    assert.equal(missingAuth.status, 401);
    assert.match(missingAuth.headers.get('content-type'), /application\/json/);
    assert.equal(missingAuth.headers.get('cache-control'), 'no-store');
    const invalidInvite = await fetch(`${base}/api/invitations/send`, { method: 'POST', body: '{}' });
    assert.equal(invalidInvite.status, 400);
    assert.match((await invalidInvite.json()).error, /inválidos/);
    assert.equal((await fetch(`${base}/api/invitations/send`)).status, 405);
    assert.equal((await fetch(`${base}/api/arquivo-inexistente`)).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
