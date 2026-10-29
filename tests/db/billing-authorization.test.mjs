import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';
async function setup() {
  const db = await createDb();
  await db.sql('update plans set published=true');
  db.setNow('2026-01-01T12:00:00Z');
  const admin = await db.createUser('owner@audit.invalid');
  const tenant = (await db.rpc(admin, 'provision_tenant', { p_request_id: crypto.randomUUID(), p_name: 'Auditoria', p_slug: 'auditoria-billing', p_document: '12345678000190', p_timezone: 'America/Sao_Paulo', p_plan_code: 'profissional', p_cycle: 'monthly' })).tenant_id;
  const limited = await db.createUser('limited@audit.invalid');
  await db.sql("insert into tenant_memberships(tenant_id,user_id,role,permissions) values($1,$2,'admin',array['team'])", [tenant, limited]);
  return { db, admin, tenant, limited };
}
async function order(s) { s.db.setNow('2026-02-02T12:00:00Z'); return s.db.rpc(s.admin, 'prepare_checkout', { p_tenant: s.tenant }); }

test('admin de equipe não delega faturamento que não possui', async () => {
 const s=await setup(); try {
 await assert.rejects(s.db.rpc(s.limited,'create_invitation',{p_tenant:s.tenant,p_email:'self@audit.invalid',p_role:'admin',p_permissions:'{team,billing}'}),/permiss|delegar/i);
 assert.equal((await s.db.sql('select id from invitations')).length,0);
 } finally {await s.db.raw.close();}
});
test('convite perde validade quando emissor é revogado', async () => {
 const s=await setup(); try {
 const recipient=await s.db.createUser('recipient@audit.invalid');
 const inv=await s.db.rpc(s.limited,'create_invitation',{p_tenant:s.tenant,p_email:'recipient@audit.invalid',p_role:'admin',p_permissions:'{team}'});
 await s.db.sql("update tenant_memberships set status='revoked' where user_id=$1",[s.limited]);
 await assert.rejects(s.db.rpc(recipient,'accept_invitation',{p_token:inv.token}),/emissor|permiss|revogado/i);
 assert.equal((await s.db.sql('select id from tenant_memberships where user_id=$1',[recipient])).length,0);
 } finally {await s.db.raw.close();}
});
test('valor-base superior ao pedido exige revisão', async () => {
 const s=await setup(); try {
 const o=await order(s);
 const [r]=await s.db.service("select apply_verified_payment($1,'excess','slug',15000,15100,1,'pix',null) r",[o.order_nsu]);
 assert.equal(r.r.result,'review'); assert.equal((await s.db.sql('select id from payments')).length,0);
 } finally {await s.db.raw.close();}
});
test('catálogo não publicado impede preparar checkout novo', async () => {
 const s=await setup(); try {
 s.db.setNow('2026-02-02T12:00:00Z'); await s.db.sql('update plans set published=false');
 await assert.rejects(s.db.rpc(s.admin,'prepare_checkout',{p_tenant:s.tenant}),/publicado|disponível/i);
 assert.equal((await s.db.sql('select id from billing_orders')).length,0);
 } finally {await s.db.raw.close();}
});
test('checkout reserva uma tentativa externa; resultado ambíguo não permite retry cego', async () => {
 const s=await setup(); try {
 const o=await order(s), attempt=crypto.randomUUID();
 const claim=async id=>(await s.db.service('select claim_checkout_link($1,$2) r',[o.order_id,id]))[0].r;
 assert.equal((await claim(attempt)).claimed,true);
 assert.equal((await claim(crypto.randomUUID())).claimed,false);
 await s.db.service("select finish_checkout_link($1,$2,null,'ambiguous')",[o.order_id,attempt]);
 assert.equal((await claim(crypto.randomUUID())).claimed,false);
 await assert.rejects(s.db.as(s.admin,'select claim_checkout_link($1,$2)',[o.order_id,crypto.randomUUID()]),/permission denied/);
 } finally {await s.db.raw.close();}
});
test('resposta tardia do provedor não reabre pedido cancelado', async () => {
 const s = await setup(); try {
   const o = await order(s), attempt = crypto.randomUUID();
   await s.db.service('select claim_checkout_link($1,$2)', [o.order_id, attempt]);
   await s.db.rpc(s.admin, 'cancel_subscription', { p_tenant: s.tenant });
   const [result] = await s.db.service("select finish_checkout_link($1,$2,'https://checkout.infinitepay.io/test','ready') ok", [o.order_id, attempt]);
   assert.equal(result.ok, false);
   const [saved] = await s.db.sql('select status, checkout_url from billing_orders where id=$1', [o.order_id]);
   assert.equal(saved.status, 'canceled');
   assert.equal(saved.checkout_url, null);
 } finally { await s.db.raw.close(); }
});

test('preço publicado é imutável; versionamento continua disponível', async () => {
 const s=await setup(); try {
 await s.db.sql('insert into platform_admins(user_id) values($1)',[s.admin]);
 await assert.rejects(s.db.as(s.admin,"update plan_prices set amount_cents=1 where cycle='monthly'"),/imutável|version/i);
 assert.ok(await s.db.rpc(s.admin,'admin_set_price',{p_plan_code:'profissional',p_cycle:'monthly',p_amount_cents:17900}));
 assert.equal((await s.db.sql('select price_cents_snapshot from subscriptions where tenant_id=$1',[s.tenant]))[0].price_cents_snapshot,16900);
 } finally {await s.db.raw.close();}
});
