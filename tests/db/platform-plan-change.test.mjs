// Troca de plano pelo painel global: papéis, idempotência, excedente sem exclusão e preço preservado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

async function setup() {
  const db = await createDb();
  db.setNow('2026-01-10T12:00:00Z');
  await db.sql('update plans set published=true');
  const owner = await db.createUser('owner@plan.invalid');
  const support = await db.createUser('support@plan.invalid');
  const sindico = await db.createUser('sindico@plan.invalid');
  await db.sql("insert into platform_admins(user_id,role) values($1,'owner'),($2,'support')", [owner, support]);
  const tenant = (await db.rpc(sindico, 'provision_tenant', {
    p_request_id: crypto.randomUUID(), p_name: 'Plano', p_slug: 'plano-teste', p_document: '22345678000190',
    p_timezone: 'America/Sao_Paulo', p_plan_code: 'profissional', p_cycle: 'monthly',
  })).tenant_id;
  const change = (who, plan, cycle = 'monthly', request = crypto.randomUUID()) => db.rpc(who, 'platform_change_plan', {
    p_tenant: tenant, p_plan_code: plan, p_cycle: cycle, p_reason: 'Ajuste comercial solicitado', p_request: request,
  });
  return { db, owner, support, sindico, tenant, change };
}

test('somente proprietário/financeiro troca; no teste vale na hora; idempotente', async () => {
  const s = await setup();
  try {
    await assert.rejects(s.change(s.support, 'prime'), /restrito|permiss/i);
    await assert.rejects(s.change(s.sindico, 'prime'), /restrito|permiss/i);
    const id = crypto.randomUUID();
    const r = await s.change(s.owner, 'prime', 'yearly', id);
    assert.equal(r.effective, 'now');
    const again = await s.change(s.owner, 'prime', 'yearly', id);
    assert.equal(again.replayed, true);
    const [sub] = await s.db.sql("select p.code, s.cycle, s.trial_ends_at from subscriptions s join plans p on p.id=s.plan_id where tenant_id=$1", [s.tenant]);
    assert.equal(sub.code, 'prime'); assert.equal(sub.cycle, 'yearly');
    assert.equal((await s.db.sql("select count(*)::int n from audit_logs where action='platform.plan_change'"))[0].n, 1);
  } finally { await s.db.raw.close(); }
});

test('downgrade com uso acima do destino é recusado sem apagar dados', async () => {
  const s = await setup();
  try {
    await s.db.sql("insert into units(tenant_id,label) select $1, n::text from generate_series(1,81) n", [s.tenant]);
    await assert.rejects(s.change(s.owner, 'essencial'), /excede|Nenhum dado/i);
    assert.equal((await s.db.sql('select count(*)::int n from units where tenant_id=$1 and active', [s.tenant]))[0].n, 81);
  } finally { await s.db.raw.close(); }
});

test('assinatura paga: troca agendada para o próximo pagamento; preço contratado intacto', async () => {
  const s = await setup();
  try {
    await s.db.sql("update subscriptions set status='active', current_period_start=now(), current_period_end=now()+interval '20 days' where tenant_id=$1", [s.tenant]);
    const before = (await s.db.sql('select price_cents_snapshot from subscriptions where tenant_id=$1', [s.tenant]))[0].price_cents_snapshot;
    const r = await s.change(s.owner, 'prime');
    assert.equal(r.effective, 'next_payment');
    const [sub] = await s.db.sql('select price_cents_snapshot, next_plan_id is not null agendado from subscriptions where tenant_id=$1', [s.tenant]);
    assert.equal(sub.price_cents_snapshot, before); assert.equal(sub.agendado, true);
  } finally { await s.db.raw.close(); }
});
