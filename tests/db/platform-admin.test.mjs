import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from './harness.mjs';

async function setup() {
  const db = await createDb();
  db.setNow('2026-01-01T12:00:00Z');
  await db.sql('update plans set published=true');
  const users = {};
  for (const role of ['owner','support','finance','auditor','resident']) {
    users[role] = await db.createUser(`${role}@platform.invalid`);
    if (role !== 'resident') await db.sql('insert into platform_admins(user_id,role) values($1,$2)', [users[role],role]);
  }
  const tenant = (await db.rpc(users.resident,'provision_tenant', {
    p_request_id:crypto.randomUUID(),p_name:'Platform test',p_slug:'platform-test',p_document:'12345678000190',
    p_timezone:'America/Sao_Paulo',p_plan_code:'profissional',p_cycle:'monthly',
  })).tenant_id;
  const action = (role,name,target,data={},request=crypto.randomUUID()) => db.rpc(users[role],'platform_action', {
    p_action:name,p_target:target,p_reason:'Justificativa de teste válida',p_data:JSON.stringify(data),p_request:request,
  });
  return {db,users,tenant,action};
}

test('contexto RBAC, owner-only legado, grants e metadata sem segredos', async () => {
  const s=await setup();
  try {
    assert.equal((await s.db.rpc(s.users.resident,'platform_context')).role,null);
    await assert.rejects(s.db.rpc(null,'platform_context'),/permission denied/);
    for (const role of ['support','finance','auditor']) {
      assert.equal((await s.db.as(s.users[role],'select app.is_platform_admin() ok'))[0].ok,false);
      await assert.rejects(s.db.rpc(s.users[role],'admin_overview'),/restrito|permissão|autorizado/i);
    }
    await assert.rejects(s.db.rpc(s.users.resident,'platform_list',{p_section:'tenants'}));
    await assert.rejects(s.db.rpc(s.users.support,'platform_list',{p_section:'orders'}));
    await assert.rejects(s.action('auditor','tenant_status',s.tenant,{status:'suspended'}));
    for (const section of ['tenants','users','team','notifications','orders','incidents','audit','contacts','plans']) {
      const list=await s.db.rpc(s.users.owner,'platform_list',{p_section:section});
      assert.ok(Array.isArray(list.rows)); assert.equal(typeof list.total,'number');
      assert.doesNotMatch(JSON.stringify(list),/password_hash|token_hash|checkout_url|recipient_secret|raw_user_meta_data/);
    }
    const list=await s.db.rpc(s.users.support,'platform_list',{p_section:'users'});
    assert.ok(list.rows.every(r=>!r.email?.includes('@platform.invalid')));
    assert.equal((await s.db.rpc(s.users.support,'platform_overview')).paid_cents,null);
    assert.equal((await s.db.rpc(s.users.owner,'platform_tenant_detail',{p_tenant:s.tenant})).tenant.id,s.tenant);
    await assert.rejects(s.db.as(s.users.owner,'select * from app.platform_requests'),/permission denied/);
    await assert.rejects(s.db.as(s.users.support,"update platform_admins set role='owner' where user_id=$1",[s.users.support]),/permission denied/);
  } finally {await s.db.raw.close();}
});

test('trial absoluto, estado explícito, idempotência, conflito, auditoria única e rollback', async () => {
  const s=await setup();
  try {
    const request=crypto.randomUUID(); const data={ends_at:'2026-03-01T12:00:00Z',trial_state:'active'};
    const first=await s.action('finance','trial_extend',s.tenant,data,request);
    const replay=await s.action('finance','trial_extend',s.tenant,data,request);
    assert.equal(first.ok,true); assert.equal(replay.replayed,true);
    assert.equal((await s.db.sql("select count(*)::int n from audit_logs where action='platform.trial_extend'"))[0].n,1);
    await assert.rejects(s.action('finance','trial_extend',s.tenant,{...data,ends_at:'2026-04-01T00:00:00Z'},request),/idempotência/);
    await assert.rejects(s.action('owner','trial_extend',s.tenant,data,request),/idempotência/);
    await assert.rejects(s.action('owner','trial_extend',s.tenant,{ends_at:'2026-04-01T00:00:00Z',trial_state:'expired'}),/incompatível/);
    await assert.rejects(s.db.rpc(s.users.owner,'admin_extend_trial',{p_tenant:s.tenant,p_new_end:null,p_reason:'Motivo suficientemente longo'}),/incompatível/);
    await assert.rejects(s.action('owner','tenant_status',s.tenant,{status:null}),/inválida/);
    await assert.rejects(s.action('owner','tenant_status',s.tenant,{status:'active',payload:'not allowed'}),/campos/);
    await assert.rejects(s.action('owner','tenant_status',crypto.randomUUID(),{status:'active'}),/não encontrado/);
    assert.equal((await s.db.sql('select count(*)::int n from app.platform_requests'))[0].n,1);
    s.db.setNow('2026-03-02T12:00:00Z');
    await s.action('finance','trial_extend',s.tenant,{ends_at:'2026-04-01T12:00:00Z',trial_state:'expired'});
    assert.equal((await s.db.rpc(s.users.owner,'platform_list',{p_section:'tenants'})).rows[0].trial_state,'active');
  } finally {await s.db.raw.close();}
});

test('último owner, autoelevação, revogação imediata e último admin tenant', async () => {
  const s=await setup();
  try {
    await assert.rejects(s.db.sql('delete from platform_admins where user_id=$1',[s.users.owner]),/Último owner/);
    await assert.rejects(s.action('owner','team_role',s.users.owner,{role:'support',active:true}),/própria/);
    await assert.rejects(s.action('support','team_role',s.users.support,{role:'owner',active:true}));
    await s.action('owner','team_role',s.users.support,{role:'support',active:false});
    assert.equal((await s.db.rpc(s.users.support,'platform_context')).role,null);
    await assert.rejects(s.db.rpc(s.users.support,'platform_list',{p_section:'users'}));
    const [m]=await s.db.sql('select id from tenant_memberships where tenant_id=$1',[s.tenant]);
    await assert.rejects(s.action('owner','membership_status',m.id,{status:'revoked'}),/Último administrador/);
    await s.action('owner','tenant_status',s.tenant,{status:'suspended'});
    assert.equal((await s.db.rpc(s.users.owner,'platform_tenant_detail',{p_tenant:s.tenant})).tenant.commercial_state,'restricted');
  } finally {await s.db.raw.close();}
});

test('retry somente falha terminal, destinatário autorizado, sem payload exposto', async () => {
  const s=await setup();
  try {
    const [j]=await s.db.sql(`insert into notification_jobs(tenant_id,event,channel,recipient,ref_id,payload,status,attempts)
      values($1,'billing_order','email','resident@platform.invalid','test','{"secret":"recipient_secret"}','failed',5) returning id`,[s.tenant]);
    const list=await s.db.rpc(s.users.support,'platform_list',{p_section:'notifications'});
    assert.equal(list.rows[0].retryable,true); assert.doesNotMatch(JSON.stringify(list),/recipient_secret|resident@platform/);
    for (const [status,attempts,locked] of [['failed',4,null],['sending',5,null],['failed',5,'2020-01-01'],['accepted',5,null],['queued',5,null]]) {
      await s.db.sql('update notification_jobs set status=$2,attempts=$3,locked_until=$4 where id=$1',[j.id,status,attempts,locked]);
      await assert.rejects(s.action('support','notification_retry',j.id,{delivery_confirmed_failed:true}),/falha terminal/);
    }
    await s.db.sql("update notification_jobs set status='failed',attempts=5,locked_until=null where id=$1",[j.id]);
    await assert.rejects(s.action('support','notification_retry',j.id),/Confirmação/);
    await s.action('support','notification_retry',j.id,{delivery_confirmed_failed:true});
    assert.equal((await s.db.sql('select status,attempts,platform_retry_count from notification_jobs where id=$1',[j.id]))[0].status,'queued');
    await assert.rejects(s.action('support','notification_retry',j.id,{delivery_confirmed_failed:true}),/falha terminal/);
  } finally {await s.db.raw.close();}
});

test('snapshot mantém franquia contratada; novos tenants recebem novos limites e preços', async () => {
  const s=await setup();
  try {
    const [plan]=await s.db.sql("select id from plans where code='profissional'");
    const old=(await s.db.rpc(s.users.resident,'subscription_overview',{p_tenant:s.tenant})).entitlements;
    await s.action('owner','plan_limits',plan.id,{max_units:old.max_units+17,feature_ocr:false});
    const same=await s.db.rpc(s.users.resident,'subscription_overview',{p_tenant:s.tenant});
    assert.equal(same.entitlements.max_units,old.max_units); assert.equal(same.entitlements.feature_ocr,old.feature_ocr);
    const newTenant=(await s.db.rpc(s.users.resident,'provision_tenant', {
      p_request_id:crypto.randomUUID(),p_name:'Novo contrato',p_slug:'novo-contrato',p_document:'12345678000191',
      p_timezone:'America/Sao_Paulo',p_plan_code:'profissional',p_cycle:'monthly',
    })).tenant_id;
    assert.equal((await s.db.rpc(s.users.resident,'subscription_overview',{p_tenant:newTenant})).entitlements.max_units,old.max_units+17);
    await assert.rejects(s.action('owner','plan_limits',plan.id,{max_units:-1}),/check constraint/);
    await s.action('owner','plan_price',plan.id,{cycle:'monthly',amount_cents:17700});
    assert.equal((await s.db.rpc(s.users.resident,'subscription_overview',{p_tenant:s.tenant})).price_cents,same.price_cents);
    await s.action('owner','plan_publish',plan.id,{published:false});
    const rows=(await s.db.rpc(s.users.owner,'platform_list',{p_section:'plans'})).rows;
    assert.equal(rows.find(p=>p.id===plan.id).prices.find(p=>p.cycle==='monthly').amount_cents,17700);
  } finally {await s.db.raw.close();}
});

test('cortesia separada: expiração exclusiva, revogação, suspensão, sem receita ou trial alterados', async () => {
  const s=await setup();
  try {
    const [before]=await s.db.sql('select trial_ends_at,current_period_end from subscriptions where tenant_id=$1',[s.tenant]);
    s.db.setNow('2026-03-01T12:00:00Z');
    const result=await s.action('finance','courtesy_grant',s.tenant,{starts_at:'2026-03-01T00:00:00Z',ends_at:'2026-03-10T00:00:00Z'});
    assert.equal((await s.db.rpc(s.users.owner,'platform_tenant_detail',{p_tenant:s.tenant})).tenant.commercial_state,'full');
    await assert.rejects(s.action('finance','courtesy_grant',s.tenant,{starts_at:'2026-03-02T00:00:00Z',ends_at:'2026-03-11T00:00:00Z'}),/sobreposta/);
    s.db.setNow('2026-03-10T00:00:00Z');
    assert.equal((await s.db.rpc(s.users.owner,'platform_tenant_detail',{p_tenant:s.tenant})).tenant.commercial_state,'restricted');
    s.db.setNow('2026-03-05T00:00:00Z');
    await s.action('owner','tenant_status',s.tenant,{status:'suspended'});
    assert.equal((await s.db.rpc(s.users.owner,'platform_tenant_detail',{p_tenant:s.tenant})).tenant.commercial_state,'restricted');
    await s.action('owner','tenant_status',s.tenant,{status:'active'});
    await s.action('finance','courtesy_revoke',result.changes.id);
    assert.equal((await s.db.rpc(s.users.owner,'platform_tenant_detail',{p_tenant:s.tenant})).tenant.commercial_state,'restricted');
    assert.deepEqual((await s.db.sql('select trial_ends_at,current_period_end from subscriptions where tenant_id=$1',[s.tenant]))[0],before);
    assert.equal((await s.db.sql('select count(*)::int n from payments'))[0].n,0);
  } finally {await s.db.raw.close();}
});

test('reset autorizado com cooldown alvo, email confirmado e auditoria sem email', async () => {
  const s=await setup();
  try {
    const args={p_user:s.users.resident,p_action:'password_reset',p_reason:'Reset solicitado pelo suporte'};
    assert.equal((await s.db.rpc(s.users.support,'platform_authorize_user_action',args)).email,'resident@platform.invalid');
    await assert.rejects(s.db.rpc(s.users.owner,'platform_authorize_user_action',args),/5 minutos/);
    await assert.rejects(s.db.rpc(s.users.support,'platform_authorize_user_action',{...args,p_user:s.users.owner}),/privilegiada/);
    await assert.rejects(s.db.rpc(s.users.finance,'platform_authorize_user_action',args));
    const unverified=await s.db.createUser('unverified@platform.invalid',{verified:false});
    await assert.rejects(s.db.rpc(s.users.owner,'platform_authorize_user_action',{...args,p_user:unverified}),/verificado/);
    const [audit]=await s.db.sql("select data from audit_logs where action='platform.password_reset_requested'");
    assert.equal(audit.data.outcome,'attempted'); assert.doesNotMatch(JSON.stringify(audit),/@platform/);
    s.db.setNow('2026-01-01T12:05:00Z');
    assert.ok((await s.db.rpc(s.users.owner,'platform_authorize_user_action',args)).email);
  } finally {await s.db.raw.close();}
});

test('paginação estável, filtros UTC, total além da página, contato e incidente sem payload', async () => {
  const s=await setup();
  try {
    await s.db.sql(`insert into contact_requests(name,email,message,created_at)
      select 'Contato '||i,'secret'||i||'@private.invalid','Mensagem privada','2026-06-10T23:59:59Z'::timestamptz
      from generate_series(1,27) i`);
    const args={p_section:'contacts',p_from:'2026-06-10',p_to:'2026-06-10'};
    const a=await s.db.rpc(s.users.finance,'platform_list',args);
    const b=await s.db.rpc(s.users.finance,'platform_list',{...args,p_page:1});
    assert.equal(a.total,27); assert.equal(a.rows.length,25); assert.equal(b.rows.length,2);
    assert.equal(new Set([...a.rows,...b.rows].map(r=>r.id)).size,27);
    assert.doesNotMatch(JSON.stringify(a),/Mensagem privada|@private/);
    await s.action('support','contact_status',a.rows[0].id,{status:'resolvido'});
    assert.equal((await s.db.rpc(s.users.finance,'platform_list',{...args,p_status:'resolvido'})).total,1);
    assert.equal((await s.db.rpc(s.users.finance,'platform_list',{...args,p_from:'2026-06-11',p_to:'2026-06-11'})).total,0);
    await assert.rejects(s.db.rpc(s.users.owner,'platform_list',{p_section:'contacts',p_page:-1}),/Filtros/);
    const [incident]=await s.db.sql("insert into billing_incidents(tenant_id,kind,detail) values($1,'test','{\"token\":\"private\"}') returning id",[s.tenant]);
    await s.action('finance','incident_resolve',incident.id);
    const list=await s.db.rpc(s.users.finance,'platform_list',{p_section:'incidents'});
    assert.equal(list.rows[0].status,'resolved'); assert.doesNotMatch(JSON.stringify(list),/token|private/);
  } finally {await s.db.raw.close();}
});
