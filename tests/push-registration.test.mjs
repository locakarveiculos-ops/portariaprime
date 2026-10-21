import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasPushRegistration, removePushRegistration } from '../src/lib/push-registration.ts';

function fake(data = null, error = null) {
  const filters = [];
  const query = {
    select() { return this; }, delete() { return this; },
    eq(key, value) { filters.push([key, value]); return this; },
    maybeSingle: async () => ({ data, error }),
    then(resolve) { return Promise.resolve({ error }).then(resolve); },
  };
  return { client: { from: () => query }, filters };
}

test('inscrição só é ativa com vínculo do usuário e tenant no servidor', async () => {
  const missing = fake();
  assert.equal(await hasPushRegistration(missing.client, 'tenant-a', 'user-a', 'https://push.test/a'), false);
  assert.deepEqual(missing.filters, [['tenant_id', 'tenant-a'], ['user_id', 'user-a'], ['endpoint', 'https://push.test/a']]);
  assert.equal(await hasPushRegistration(fake({ id: 'x' }).client, 'a', 'u', 'https://push.test/a'), true);
});

test('remoção não alcança outros tenants ou usuários', async () => {
  const f = fake();
  await removePushRegistration(f.client, 'tenant-a', 'user-a', 'https://push.test/a');
  assert.deepEqual(f.filters, [['tenant_id', 'tenant-a'], ['user_id', 'user-a'], ['endpoint', 'https://push.test/a']]);
});

test('falha no banco não aparece como desativação concluída', async () => {
  await assert.rejects(removePushRegistration(fake(null, { message: 'offline' }).client, 'a', 'u', 'https://push.test/a'), /desativar/);
});
