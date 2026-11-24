// Conversas guardadas no Portaria Prime: sem acesso direto de usuários, dados válidos, sem duplicar e retenção de 90 dias.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

test('whatsapp_chat_messages: só service_role, validações, chave única e retenção', async () => {
  const db = await createDb();
  await db.sql('update plans set published = true');
  const owner = await db.createUser('o@chat.invalid', { name: 'Síndica' });
  const { tenant_id: T } = await db.rpc(owner, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Cond Chat', p_slug: 'chat-a',
    p_document: '11444777000161', p_timezone: 'America/Sao_Paulo', p_plan_code: 'prime', p_cycle: 'monthly' });

  for (const role of ['authenticated', 'anon']) {
    for (const t of ['whatsapp_chat_messages', 'whatsapp_chat_hooks']) {
      const [p] = await db.sql(`select has_table_privilege($1, $2, 'select') s, has_table_privilege($1, $2, 'insert') i`, [role, `public.${t}`]);
      assert.deepEqual([p.s, p.i], [false, false], `${role} sem acesso a ${t}`);
    }
  }
  const [f] = await db.sql(`select has_function_privilege('authenticated', 'public.whatsapp_chat_messages_retention(int)', 'execute') a`);
  assert.equal(f.a, false);

  const ins = (id, at, jid = '123456789012345@lid') => db.service(
    `insert into whatsapp_chat_messages(tenant_id, id, jid, from_me, at, text) values($1::uuid, $2, $3, false, $4::timestamptz, 'oi') on conflict do nothing`, [T, id, jid, at]);
  await ins('3EB0AAAA0001', new Date().toISOString());
  await ins('3EB0AAAA0001', new Date().toISOString());
  assert.equal((await db.sql('select count(*)::int n from whatsapp_chat_messages'))[0].n, 1, 'mesmo id não duplica');
  await assert.rejects(ins('3EB0AAAA0002', new Date().toISOString(), '120363000000@g.us'), /check/, 'grupo recusado');
  await assert.rejects(ins('x', new Date().toISOString()), /check/, 'id inválido recusado');
  await assert.rejects(db.service(`insert into whatsapp_chat_hooks(tenant_id, instance, secret) values($1::uuid, 'Tubarao', repeat('a', 64))`, [T]), /check/,
    'só instâncias pp-*');

  await ins('3EB0AAAA0003', new Date(Date.now() - 91 * 86400_000).toISOString());
  const [{ r }] = await db.service('select public.whatsapp_chat_messages_retention(5000) r');
  assert.equal(r, 1, 'apaga só as com mais de 90 dias');
  assert.deepEqual((await db.sql('select id from whatsapp_chat_messages')).map((x) => x.id), ['3EB0AAAA0001']);
});
