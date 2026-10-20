import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTenantInfo } from '../src/lib/tenant-data.ts';

const link = { tenant_id: 'a' };
function client(failBranding = false) {
  return { from(table) {
    return { select() { return this; }, eq() { return this; },
      async single() { return { data: { id: 'a' }, error: null }; },
      async maybeSingle() { return failBranding ? { data: null, error: { message: 'falha' } } : { data: null, error: null }; },
    };
  } };
}

test('falha financeira não é ocultada como overview nulo', async () => {
  await assert.rejects(loadTenantInfo(client(), async () => { throw new Error('Assinatura indisponível'); }, link.tenant_id), /Assinatura indisponível/);
});
test('falha da marca deve permitir retry, não aplicar marca vazia como sucesso', async () => {
  await assert.rejects(loadTenantInfo(client(true), async () => ({}), link.tenant_id), /marca/i);
});
test('dados completos retornam juntos', async () => {
  const data = await loadTenantInfo(client(), async () => ({ status: 'trialing' }), link.tenant_id);
  assert.equal(data.tenant.id, 'a');
  assert.equal(data.overview.status, 'trialing');
});
